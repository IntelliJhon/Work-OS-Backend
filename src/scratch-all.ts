import { db } from './db';
import { projects } from './db/schema/projects';
import { epics } from './db/schema/epics';
import { stories } from './db/schema/stories';
import { sprints } from './db/schema/sprints';
import { phases } from './db/schema/phases';
import { users } from './db/schema/users';
import { withTenant } from './middleware/tenant.middleware';

async function main() {
  const tenantId = 'fda80ed9-f995-4e51-9a72-9484f07e075b';
  console.log(`Running diagnostic query for tenant: ${tenantId}...`);

  await withTenant(tenantId, async (tx) => {
    const allUsers = await tx.select().from(users);
    console.log('--- USERS ---');
    console.log(allUsers.map((u: any) => ({ id: u.id, email: u.email })));

    const allProjects = await tx.select().from(projects);
    console.log('--- PROJECTS ---');
    console.log(allProjects.map((p: any) => ({ id: p.id, name: p.name })));

    const allPhases = await tx.select().from(phases);
    console.log('--- PHASES ---');
    console.log(allPhases.map((ph: any) => ({ id: ph.id, name: ph.name, projectId: ph.projectId, status: ph.status })));

    const allSprints = await tx.select().from(sprints);
    console.log('--- SPRINTS ---');
    console.log(allSprints.map((s: any) => ({ id: s.id, name: s.name, projectId: s.projectId, status: s.status })));

    const allEpics = await tx.select().from(epics);
    console.log('--- EPICS ---');
    console.log(allEpics.map((e: any) => ({ id: e.id, name: e.name, projectId: e.projectId })));

    const allStories = await tx.select().from(stories);
    console.log('--- STORIES ---');
    console.log(allStories.map((s: any) => ({ id: s.id, name: s.name, epicId: s.epicId, projectId: s.projectId })));
  });

  process.exit(0);
}

main().catch(console.error);
