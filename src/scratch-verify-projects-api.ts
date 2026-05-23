async function main() {
  try {
    const baseUrl = 'http://localhost:5000/api';
    console.log("Logging in as admin@acme.com...");
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: 'acme-corporation-1779259460204',
        email: 'admin@acme.com',
        password: 'Password123!'
      })
    });
    
    if (!loginRes.ok) {
      console.error("Login failed:", loginRes.status, await loginRes.text());
      return;
    }
    
    const loginData = await loginRes.json() as any;
    const token = loginData.accessToken;
    console.log("Login successful! Token acquired.");

    console.log("\nFetching projects list...");
    const projectsRes = await fetch(`${baseUrl}/projects`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!projectsRes.ok) {
      console.error("Projects fetch failed:", projectsRes.status, await projectsRes.text());
      return;
    }

    const projectsData = await projectsRes.json() as any[];
    console.log(`Received ${projectsData.length} projects:`);
    for (const p of projectsData) {
      const hasPhases = p.phases !== undefined;
      const phasesCount = hasPhases ? p.phases.length : 0;
      const completedPhases = hasPhases ? p.phases.filter((ph: any) => ph.status === 'completed').length : 0;
      console.log(`- Project: ${p.name} | ID: ${p.id} | Status: ${p.status} | Has phases field: ${hasPhases} | Phases count: ${phasesCount} | Completed phases: ${completedPhases}`);
      if (hasPhases && phasesCount > 0) {
        console.log("  Phases detail:");
        for (const ph of p.phases) {
          console.log(`    Phase: ${ph.name} | Status: ${ph.status}`);
        }
      }
    }
  } catch (err: any) {
    console.error("Error fetching projects API:", err.message);
  }
}

main();
