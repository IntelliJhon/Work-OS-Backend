import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const filePath = path.join(__dirname, '..', '..', 'FRONTEND', 'src', 'pages', 'projects', 'ProjectSprints.tsx');
  console.log("Analyzing UI file:", filePath);
  
  if (!fs.existsSync(filePath)) {
    console.error("File not found!");
    return;
  }
  
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  
  console.log("\nSearching for sprint render regions...");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('sprints.map') || line.includes('activeSprint') || line.includes('Calendar') || line.includes('backlog') || line.includes('status ===') || line.includes('sprint.') || line.includes('Active Sprint')) {
      if (line.includes('map') || line.includes('Backlog') || line.includes('Active') || line.includes('card') || line.includes('header')) {
        console.log(`Line ${i + 1}: ${line.trim()}`);
      }
    }
  }
}

main();
