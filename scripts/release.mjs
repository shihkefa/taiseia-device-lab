import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const version=process.argv[2];
if(!/^\d+\.\d+\.\d+$/.test(version||''))throw Error('Usage: node scripts/release.mjs 1.3.7');
const packagePath=path.join(root,'package.json'),pkg=JSON.parse(fs.readFileSync(packagePath,'utf8'));
pkg.version=version;pkg.scripts.release='node scripts/release.mjs';fs.writeFileSync(packagePath,JSON.stringify(pkg)+'\n');
for(const name of fs.readdirSync(path.join(root,'dist')).filter(n=>n.endsWith('.js'))){
  const file=path.join(root,'dist',name);
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replaceAll('\r\n','\n').replace(/from '(\.\/[^'?]+\.js)(?:\?v=[^']+)?'/g,(_,module)=>`from '${module}?v=${version}'`));
}
const index=path.join(root,'dist/index.html');
fs.writeFileSync(index,fs.readFileSync(index,'utf8').replaceAll('\r\n','\n').replace(/(<span id="release-version">)v[^<]+/,`$1v${version}`).replace(/((?:src|href)="\.\/[^"?]+\.(?:js|css))(?:\?v=[^"]+)?"/g,`$1?v=${version}"`));
