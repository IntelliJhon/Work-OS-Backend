const fs = require('fs');
const path = require('path');

function replaceInFile(filePath, replacements) {
    if (!fs.existsSync(filePath)) return;
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;
    for (const [search, replace] of replacements) {
        content = content.split(search).join(replace);
    }
    if (content !== original) {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`Updated ${filePath}`);
    }
}

function processDirectory(directory) {
    const files = fs.readdirSync(directory);
    for (const file of files) {
        const fullPath = path.join(directory, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            processDirectory(fullPath);
        } else if (fullPath.endsWith('.routes.ts')) {
            replaceInFile(fullPath, [
                ['import { authMiddleware }', 'import { authenticate }'],
                ['authMiddleware', 'authenticate'],
                ['import { validateSchema }', 'import { validateRequest }'],
                ['validateSchema(', 'validateRequest(']
            ]);
        } else if (fullPath.endsWith('.controller.ts')) {
            replaceInFile(fullPath, [
                ['req.params.id;', 'req.params.id as string;']
            ]);
        }
    }
}

processDirectory(path.join(__dirname, 'src', 'modules'));

// Fix test-rls.ts and db/seeds/index.ts slug issue
const rlsTestPath = path.join(__dirname, 'src', 'test-rls.ts');
replaceInFile(rlsTestPath, [
    ["name: 'Tenant A'", "name: 'Tenant A', slug: 'tenant-a'"],
    ["name: 'Tenant B'", "name: 'Tenant B', slug: 'tenant-b'"]
]);

const seedsPath = path.join(__dirname, 'src', 'db', 'seeds', 'index.ts');
replaceInFile(seedsPath, [
    ["name: 'Acme Corp'", "name: 'Acme Corp', slug: 'acme-corp'"]
]);

// Fix test-hierarchy.ts adminUser potentially undefined
const hierarchyPath = path.join(__dirname, 'src', 'test-hierarchy.ts');
replaceInFile(hierarchyPath, [
    ["console.log(`Using User: ${adminUser.email}`);", "console.log(`Using User: ${adminUser!.email}`);"]
]);

console.log("All fixes applied.");
