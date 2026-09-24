// Build gate (#1255): dist bundles must contain zero relative dynamic
// import()/require() text. Any occurrence is a JSDoc type annotation leaked
// from a bundled dep (undici), which bun-based plugin loaders (opencode)
// resolve as real file paths at load time → ENOENT → silently dead lane.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = fileURLToPath(new URL("../dist", import.meta.url));
const relRefRe = /\b(?:import|require)\(\s*["'](?:\.{1,2}\/)[^"']*["']\s*\)/g;

function jsFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...jsFiles(p));
        else if (name.endsWith(".js")) out.push(p);
    }
    return out;
}

let found = 0;
for (const file of jsFiles(distDir).sort()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
        relRefRe.lastIndex = 0;
        let m;
        while ((m = relRefRe.exec(line))) {
            console.error(`${file}:${i + 1}: ${m[0]}`);
            found++;
        }
    });
}

if (found > 0) {
    console.error(`dist-import-annotations: FAIL — ${found} relative import()/require() ref(s) in dist`);
    process.exit(1);
}
console.log("dist-import-annotations: OK");
