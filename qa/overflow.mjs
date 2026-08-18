import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
const SITE='/home/claude/fatty-lumpkin/site';
const MIME={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg'};
const server=http.createServer((req,res)=>{const rel=decodeURIComponent(req.url.split('?')[0]);
 const f=path.join(SITE, rel==='/'?'index.html':rel);
 if(!fs.existsSync(f)){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);});
await new Promise(r=>server.listen(0,r));
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
for (const vp of [{width:1100,height:800},{width:390,height:844}]) {
  const ctx=await b.newContext({viewport:vp}); const p=await ctx.newPage();
  await p.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'networkidle'});
  const bad=await p.evaluate((w)=>{
    const out=[];
    for (const el of document.querySelectorAll('*')) {
      const r=el.getBoundingClientRect();
      if (r.right > w+1 || r.left < -1) out.push(`${el.tagName}.${(el.className||'').toString().split(' ')[0]} left=${Math.round(r.left)} right=${Math.round(r.right)}`);
    }
    return out.slice(0,10);
  }, vp.width);
  console.log(vp.width, JSON.stringify(bad,null,1));
  await ctx.close();
}
await b.close(); server.close();
