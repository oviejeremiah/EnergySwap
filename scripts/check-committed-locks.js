// Read the HEAD versions of dependency locks straight from git, so the check
// reflects what GitHub actually contains rather than any local chance.
const { execSync } = require('child_process');

function pkg(root, name) {
    const lock = JSON.parse(execSync(`git show HEAD:${root}/package-lock.json`, { encoding: 'utf8', maxBuffer: 1e8 }));
    const hits = [];
    for (const [key, val] of Object.entries(lock.packages)) {
        if (new RegExp(`(^|/)${name.replace(/@/, '@')}$`.replace('\\@', '@')).test(name) === false) continue; // no-op guard
        if (key === name) hits.push({ path: key, version: val.version });
        if (key.endsWith('/' + name)) hits.push({ path: key, version: val.version });
    }
    return hits;
}

const wanted = ['proxy-addr', 'protobufjs', '@grpc/grpc-js', 'axios', 'body-parser', 'shell-quote', 'form-data', 'vite', 'vitest', 'tinypool'];
for (const root of ['package-lock.json', 'EnergySwapBackend/package-lock.json', 'EnergySwapFrontend/package-lock.json']) {
    console.log(`===== ${root} =====`);
    const lock = JSON.parse(execSync(`git show HEAD:${root}`, { encoding: 'utf8', maxBuffer: 1e8 }));
    for (const [key, val] of Object.entries(lock.packages)) {
        const base = key.split('node_modules/').pop();
        if (wanted.includes(base)) console.log(`${key} -> ${val.version}`);
    }
}
