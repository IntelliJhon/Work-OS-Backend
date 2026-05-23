CREATE TYPE "public"."phase_status" AS ENUM('pending', 'active', 'completed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."sprint_status" AS ENUM('planning', 'active', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."gate_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "quality_gates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"phase_id" uuid NOT NULL,
	"criteria" jsonb NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp,
	"status" "gate_status" DEFAULT 'pending' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "phases" ALTER COLUMN "status" SET DEFAULT 'pending'::"public"."phase_status";--> statement-breakpoint
ALTER TABLE "phases" ALTER COLUMN "status" SET DATA TYPE "public"."phase_status" USING "status"::"public"."phase_status";--> statement-breakpoint
ALTER TABLE "sprints" ALTER COLUMN "status" SET DEFAULT 'planning'::"public"."sprint_status";--> statement-breakpoint
ALTER TABLE "sprints" ALTER COLUMN "status" SET DATA TYPE "public"."sprint_status" USING "status"::"public"."sprint_status";--> statement-breakpoint
ALTER TABLE "quality_gates" ADD CONSTRAINT "quality_gates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_gates" ADD CONSTRAINT "quality_gates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_gates" ADD CONSTRAINT "quality_gates_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_gates" ADD CONSTRAINT "quality_gates_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_gates_project_id" ON "quality_gates" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_gates_phase_id" ON "quality_gates" USING btree ("phase_id");