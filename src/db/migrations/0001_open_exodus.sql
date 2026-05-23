ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pm_id" uuid;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_pm_id_users_id_fk" FOREIGN KEY ("pm_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_log_user_id" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_tenant_id" ON "refresh_tokens" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_epics_project_id" ON "epics" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_users_role_id" ON "users" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "idx_projects_pm_id" ON "projects" USING btree ("pm_id");--> statement-breakpoint
CREATE INDEX "idx_phases_project_id" ON "phases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_sprints_project_id" ON "sprints" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_sprints_phase_id" ON "sprints" USING btree ("phase_id");--> statement-breakpoint
CREATE INDEX "idx_stories_epic_id" ON "stories" USING btree ("epic_id");--> statement-breakpoint
CREATE INDEX "idx_stories_project_id" ON "stories" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_project_id" ON "tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_story_id" ON "tasks" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_sprint_id" ON "tasks" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_assignee_id" ON "tasks" USING btree ("assignee_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_email_unique" UNIQUE("tenant_id","email");