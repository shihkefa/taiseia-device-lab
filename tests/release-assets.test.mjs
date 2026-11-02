import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const root=new URL('../',import.meta.url),pkg=JSON.parse(fs.readFileSync(new URL('package.json',root),'utf8'));
test('HTML and every imported module use one release URL so a new header cannot load cached old protocol code',()=>{
  const dir=new URL('dist/',root),html=fs.readFileSync(new URL('index.html',dir),'utf8');
  assert.ok(html.includes(`src="./app.js?v=${pkg.version}"`));
  for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.js'))){
    const source=fs.readFileSync(new URL(name,dir),'utf8');
    for(const [,module] of source.matchAll(/from '(\.\/[^']+)'/g)){
      const url=new URL(module,dir);assert.equal(url.searchParams.get('v'),pkg.version,name+' import '+module);
      assert.ok(fs.existsSync(new URL(url.pathname,url)),module);
    }
  }
});
