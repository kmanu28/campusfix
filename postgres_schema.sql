-- ============================================================================
-- CampusFix: Intelligent Campus Complaint Management and Resolution System
-- PostgreSQL + pgvector Production Schema
-- Designed for DBMS Level 3 Experiential Learning Project
-- Aligned with Chen ER Diagram and Relational Schema (.drawio)
-- ============================================================================

-- 0. Enable Extensions
CREATE EXTENSION IF NOT EXISTS "vector"; -- pgvector for semantic search & duplicate detection

-- Drop existing objects for clean setup (if needed)
DROP TRIGGER IF EXISTS trg_complaint_status_audit ON complaints;
DROP PROCEDURE IF EXISTS sp_create_complaint(BIGINT, BIGINT, VARCHAR, TEXT, VARCHAR, VARCHAR, BIGINT);
DROP PROCEDURE IF EXISTS sp_assign_staff(BIGINT, BIGINT, BIGINT);
DROP FUNCTION IF EXISTS trg_fn_complaint_status_audit() CASCADE;
DROP FUNCTION IF EXISTS fn_calculate_avg_resolution_hours(BIGINT);
DROP VIEW IF EXISTS view_department_analytics CASCADE;
DROP VIEW IF EXISTS view_pending_complaints CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS complaint_embeddings CASCADE;
DROP TABLE IF EXISTS feedback CASCADE;
DROP TABLE IF EXISTS status_history CASCADE;
DROP TABLE IF EXISTS assignments CASCADE;
DROP TABLE IF EXISTS complaints CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS departments CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS roles CASCADE;

-- ============================================================================
-- 1. DDL: RELATIONAL TABLES WITH CONSTRAINTS
-- ============================================================================

-- 1.1 ROLES
CREATE TABLE roles (
    role_id SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_name VARCHAR(20) NOT NULL UNIQUE,
    CONSTRAINT chk_roles_name CHECK (role_name IN ('REPORTER', 'STAFF', 'ADMIN'))
);

-- 1.2 USERS
CREATE TABLE users (
    user_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_id SMALLINT NOT NULL REFERENCES roles(role_id) ON DELETE RESTRICT,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_user_email CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);

-- 1.3 DEPARTMENTS
CREATE TABLE departments (
    department_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    department_name VARCHAR(100) NOT NULL UNIQUE,
    CONSTRAINT chk_dept_name_nonblank CHECK (length(trim(department_name)) > 0)
);

-- 1.4 CATEGORIES
CREATE TABLE categories (
    category_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    department_id BIGINT NOT NULL REFERENCES departments(department_id) ON DELETE RESTRICT,
    category_name VARCHAR(100) NOT NULL,
    target_hours INTEGER NOT NULL,
    CONSTRAINT uq_dept_category UNIQUE (department_id, category_name),
    CONSTRAINT chk_target_hours_positive CHECK (target_hours > 0)
);

-- 1.5 COMPLAINTS
CREATE TABLE complaints (
    complaint_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reporter_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    category_id BIGINT NOT NULL REFERENCES categories(category_id) ON DELETE RESTRICT,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    location_text VARCHAR(200) NOT NULL,
    priority VARCHAR(10) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'SUBMITTED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMPTZ NULL,
    CONSTRAINT chk_complaint_priority CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
    CONSTRAINT chk_complaint_status CHECK (status IN ('SUBMITTED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED')),
    CONSTRAINT chk_complaint_resolution_time CHECK (resolved_at IS NULL OR resolved_at >= created_at),
    CONSTRAINT chk_complaint_resolved_consistency CHECK (
        (status = 'RESOLVED' AND resolved_at IS NOT NULL) OR 
        (status <> 'RESOLVED' AND resolved_at IS NULL)
    )
);

-- 1.6 ASSIGNMENTS
CREATE TABLE assignments (
    assignment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    complaint_id BIGINT NOT NULL REFERENCES complaints(complaint_id) ON DELETE CASCADE,
    staff_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    assigned_by BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMPTZ NULL,
    CONSTRAINT chk_assignment_time CHECK (ended_at IS NULL OR ended_at >= assigned_at)
);

-- Unique index to guarantee at most one active (open) assignment per complaint
CREATE UNIQUE INDEX idx_unique_active_assignment 
ON assignments (complaint_id) 
WHERE ended_at IS NULL;

-- 1.7 STATUS_HISTORY (Audit Log)
CREATE TABLE status_history (
    history_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    complaint_id BIGINT NOT NULL REFERENCES complaints(complaint_id) ON DELETE CASCADE,
    changed_by BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    old_status VARCHAR(20) NULL,
    new_status VARCHAR(20) NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    remarks TEXT NULL,
    CONSTRAINT chk_history_status CHECK (new_status IN ('SUBMITTED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED'))
);

-- 1.8 FEEDBACK (1-to-0..1 relationship with COMPLAINTS)
CREATE TABLE feedback (
    complaint_id BIGINT PRIMARY KEY REFERENCES complaints(complaint_id) ON DELETE CASCADE,
    rating SMALLINT NOT NULL,
    comment TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_feedback_rating CHECK (rating BETWEEN 1 AND 5)
);

-- 1.9 COMPLAINT_EMBEDDINGS (Vector Semantic Search & Duplicate Detection)
CREATE TABLE complaint_embeddings (
    complaint_id BIGINT PRIMARY KEY REFERENCES complaints(complaint_id) ON DELETE CASCADE,
    embedding vector(384) NOT NULL, -- 384-dimensional dense vector (e.g. all-MiniLM-L6-v2)
    model_name VARCHAR(150) NOT NULL,
    content_hash CHAR(64) NOT NULL, -- SHA-256 hash to detect text modification
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 1.10 NOTIFICATIONS
CREATE TABLE notifications (
    notification_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    complaint_id BIGINT NULL REFERENCES complaints(complaint_id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 2. INDEXES FOR PERFORMANCE OPTIMIZATION
-- ============================================================================

-- B-Tree Indexes on Foreign Keys and High-Frequency Filtering Fields
CREATE INDEX idx_complaints_reporter ON complaints(reporter_id);
CREATE INDEX idx_complaints_category ON complaints(category_id);
CREATE INDEX idx_complaints_status ON complaints(status);
CREATE INDEX idx_complaints_priority ON complaints(priority);
CREATE INDEX idx_complaints_created_at ON complaints(created_at DESC);

CREATE INDEX idx_assignments_complaint ON assignments(complaint_id);
CREATE INDEX idx_assignments_staff ON assignments(staff_id);

CREATE INDEX idx_status_history_complaint ON status_history(complaint_id);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE is_read = FALSE;

-- Cosine Distance HNSW Index for Fast Vector Similarity Search
CREATE INDEX idx_complaint_embeddings_hnsw 
ON complaint_embeddings 
USING hnsw (embedding vector_cosine_ops);

-- ============================================================================
-- 3. VIEWS FOR DASHBOARDS AND REPORTING
-- ============================================================================

-- 3.1 Pending Complaints with Department & Assigned Staff Details
CREATE OR REPLACE VIEW view_pending_complaints AS
SELECT 
    c.complaint_id,
    c.title,
    c.description,
    c.location_text,
    c.priority,
    c.status,
    c.created_at,
    cat.category_name,
    cat.target_hours,
    dept.department_id,
    dept.department_name,
    rep.user_id AS reporter_id,
    rep.full_name AS reporter_name,
    rep.email AS reporter_email,
    staff.user_id AS staff_id,
    staff.full_name AS staff_name,
    a.assigned_at,
    ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - c.created_at)) / 3600.0, 2) AS hours_open,
    CASE 
        WHEN EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - c.created_at)) / 3600.0 > cat.target_hours 
        THEN TRUE 
        ELSE FALSE 
    END AS is_overdue
FROM complaints c
JOIN categories cat ON c.category_id = cat.category_id
JOIN departments dept ON cat.department_id = dept.department_id
JOIN users rep ON c.reporter_id = rep.user_id
LEFT JOIN assignments a ON c.complaint_id = a.complaint_id AND a.ended_at IS NULL
LEFT JOIN users staff ON a.staff_id = staff.user_id
WHERE c.status NOT IN ('RESOLVED', 'REJECTED');

-- 3.2 Department-wise Resolution Analytics View
CREATE OR REPLACE VIEW view_department_analytics AS
SELECT 
    d.department_id,
    d.department_name,
    COUNT(c.complaint_id) AS total_complaints,
    COUNT(CASE WHEN c.status IN ('SUBMITTED', 'ASSIGNED', 'IN_PROGRESS') THEN 1 END) AS pending_complaints,
    COUNT(CASE WHEN c.status = 'RESOLVED' THEN 1 END) AS resolved_complaints,
    COUNT(CASE WHEN c.status = 'REJECTED' THEN 1 END) AS rejected_complaints,
    ROUND(
        AVG(CASE 
            WHEN c.status = 'RESOLVED' 
            THEN EXTRACT(EPOCH FROM (c.resolved_at - c.created_at)) / 3600.0 
        END)::numeric, 
        2
    ) AS avg_resolution_hours,
    ROUND(AVG(f.rating)::numeric, 2) AS avg_satisfaction_rating
FROM departments d
LEFT JOIN categories cat ON d.department_id = cat.department_id
LEFT JOIN complaints c ON cat.category_id = c.category_id
LEFT JOIN feedback f ON c.complaint_id = f.complaint_id
GROUP BY d.department_id, d.department_name;

-- ============================================================================
-- 4. STORED PROCEDURES & FUNCTIONS
-- ============================================================================

-- 4.1 Stored Function: Calculate Average Resolution Time (in Hours) for a Department
CREATE OR REPLACE FUNCTION fn_calculate_avg_resolution_hours(p_dept_id BIGINT)
RETURNS NUMERIC AS $$
DECLARE
    v_avg_hours NUMERIC;
BEGIN
    SELECT ROUND(AVG(EXTRACT(EPOCH FROM (c.resolved_at - c.created_at)) / 3600.0)::numeric, 2)
    INTO v_avg_hours
    FROM complaints c
    JOIN categories cat ON c.category_id = cat.category_id
    WHERE cat.department_id = p_dept_id
      AND c.status = 'RESOLVED';

    RETURN COALESCE(v_avg_hours, 0.0);
END;
$$ LANGUAGE plpgsql STABLE;

-- 4.2 Stored Procedure: Atomic Complaint Creation with Initial Status History + Admin Notification
-- Called by POST /api/complaints inside the application's transaction.
CREATE OR REPLACE PROCEDURE sp_create_complaint(
    p_reporter_id BIGINT,
    p_category_id BIGINT,
    p_title VARCHAR,
    p_description TEXT,
    p_location_text VARCHAR,
    p_priority VARCHAR,
    INOUT p_complaint_id BIGINT DEFAULT NULL
)
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO complaints (reporter_id, category_id, title, description, location_text, priority, status)
    VALUES (p_reporter_id, p_category_id, p_title, p_description, p_location_text, p_priority, 'SUBMITTED')
    RETURNING complaint_id INTO p_complaint_id;

    INSERT INTO status_history (complaint_id, changed_by, old_status, new_status, remarks)
    VALUES (p_complaint_id, p_reporter_id, NULL, 'SUBMITTED', 'Complaint submitted by reporter');

    INSERT INTO notifications (user_id, complaint_id, message)
    SELECT u.user_id, p_complaint_id, 'New complaint #' || p_complaint_id || ' submitted: ' || p_title
    FROM users u
    JOIN roles r ON u.role_id = r.role_id
    WHERE r.role_name = 'ADMIN' AND u.is_active;
END;
$$;

-- 4.3 Stored Procedure: Transactional Staff Assignment / Reassignment (with validation)
-- Called by POST /api/complaints/:id/assign. Raises readable exceptions for invalid input.
CREATE OR REPLACE PROCEDURE sp_assign_staff(
    p_complaint_id BIGINT,
    p_staff_id BIGINT,
    p_admin_id BIGINT
)
LANGUAGE plpgsql AS $$
DECLARE
    v_status VARCHAR(20);
BEGIN
    SELECT status INTO v_status FROM complaints WHERE complaint_id = p_complaint_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Complaint #% does not exist', p_complaint_id;
    END IF;
    IF v_status IN ('RESOLVED', 'REJECTED') THEN
        RAISE EXCEPTION 'Complaint #% is already % and cannot be (re)assigned', p_complaint_id, v_status;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM users u JOIN roles r ON u.role_id = r.role_id
        WHERE u.user_id = p_staff_id AND r.role_name = 'STAFF' AND u.is_active
    ) THEN
        RAISE EXCEPTION 'User #% is not an active maintenance staff member', p_staff_id;
    END IF;

    -- Context for the audit trigger
    PERFORM set_config('app.user_id', p_admin_id::text, true);
    PERFORM set_config('app.remarks', 'Technician assigned by admin', true);

    UPDATE assignments
    SET ended_at = CURRENT_TIMESTAMP
    WHERE complaint_id = p_complaint_id AND ended_at IS NULL;

    INSERT INTO assignments (complaint_id, staff_id, assigned_by, assigned_at)
    VALUES (p_complaint_id, p_staff_id, p_admin_id, CURRENT_TIMESTAMP);

    -- SUBMITTED -> ASSIGNED (audit row is written by the trigger)
    UPDATE complaints SET status = 'ASSIGNED'
    WHERE complaint_id = p_complaint_id AND status = 'SUBMITTED';

    INSERT INTO notifications (user_id, complaint_id, message)
    VALUES (p_staff_id, p_complaint_id, 'You have been assigned to complaint #' || p_complaint_id);
END;
$$;

-- ============================================================================
-- 5. TRIGGERS
-- ============================================================================

-- 5.1 Status audit trigger.
--  * Validates the status workflow at the database level (integrity does not depend on the app):
--        SUBMITTED   -> ASSIGNED | REJECTED
--        ASSIGNED    -> IN_PROGRESS | RESOLVED | REJECTED
--        IN_PROGRESS -> ASSIGNED | RESOLVED | REJECTED
--        RESOLVED    -> IN_PROGRESS            (re-open)
--        REJECTED    -> SUBMITTED              (reconsidered)
--  * Maintains resolved_at.
--  * Writes exactly ONE status_history row per transition. The acting user and remarks come from the
--    transaction-local settings app.user_id / app.remarks (set by the application); when absent the
--    reporter is recorded as a fallback.
CREATE OR REPLACE FUNCTION trg_fn_complaint_status_audit()
RETURNS TRIGGER AS $$
DECLARE
    v_actor BIGINT;
    v_remarks TEXT;
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF NOT (
            (OLD.status = 'SUBMITTED'   AND NEW.status IN ('ASSIGNED', 'REJECTED')) OR
            (OLD.status = 'ASSIGNED'    AND NEW.status IN ('IN_PROGRESS', 'RESOLVED', 'REJECTED')) OR
            (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('ASSIGNED', 'RESOLVED', 'REJECTED')) OR
            (OLD.status = 'RESOLVED'    AND NEW.status = 'IN_PROGRESS') OR
            (OLD.status = 'REJECTED'    AND NEW.status = 'SUBMITTED')
        ) THEN
            RAISE EXCEPTION 'Invalid status transition: % -> %', OLD.status, NEW.status;
        END IF;

        IF NEW.status = 'RESOLVED' THEN
            NEW.resolved_at := CURRENT_TIMESTAMP;
        ELSIF OLD.status = 'RESOLVED' THEN
            NEW.resolved_at := NULL;
        END IF;

        v_actor := COALESCE(NULLIF(current_setting('app.user_id', true), '')::BIGINT, NEW.reporter_id);
        v_remarks := COALESCE(
            NULLIF(current_setting('app.remarks', true), ''),
            'Status changed from ' || OLD.status || ' to ' || NEW.status
        );

        INSERT INTO status_history (complaint_id, changed_by, old_status, new_status, changed_at, remarks)
        VALUES (NEW.complaint_id, v_actor, OLD.status, NEW.status, CURRENT_TIMESTAMP, v_remarks);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_complaint_status_audit
BEFORE UPDATE OF status ON complaints
FOR EACH ROW
EXECUTE FUNCTION trg_fn_complaint_status_audit();
