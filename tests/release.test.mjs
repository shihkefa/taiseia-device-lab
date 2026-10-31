import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('the static header exposes the package release version and fixed publication date',async()=>{
  const [html,manifest]=await Promise.all([
    readFile(new URL('../dist/index.html',import.meta.url),'utf8'),
    readFile(new URL('../package.json',import.meta.url),'utf8'),
  ]);
  const pkg=JSON.parse(manifest),header=html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1];
  assert(header,'release information belongs in the visible page header');
  const version=header.match(/<span\s+id="release-version">([^<]+)<\/span>/)?.[1];
  const date=header.match(/<time\s+id="release-date"\s+datetime="([^"]+)"\s+title="([^"]+)">([^<]+)<\/time>/);
  assert.equal(version,`v${pkg.version}`);
  assert.match(pkg.version,/^\d+\.\d+\.\d+$/);
  assert(date,'publication date is present without executing JavaScript');
  assert.match(pkg.releaseDate,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(date[1],pkg.releaseDate);
  assert.equal(date[3],pkg.releaseDate);
  assert.equal(date[2],`發布日期（${pkg.releaseTimeZone}）`);
  assert.equal(pkg.releaseTimeZone,'Asia/Shanghai');
});
