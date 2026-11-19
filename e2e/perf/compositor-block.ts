/** A bounded, local compositor check. Screenshots during a 500ms main-thread block, plus trace reasons. */
import { chromium } from '@playwright/test';
import { mkdirSync,writeFileSync } from 'node:fs';
const dir=process.argv[2]!;mkdirSync(dir,{recursive:true});
const browser=await chromium.launch();try{const page=await browser.newPage({viewport:{width:500,height:240}});const c=await page.context().newCDPSession(page);await c.send('Page.enable');
for(const property of ['backgroundColor','transform','height']){
await page.setContent('<style>body{margin:0;background:white}#a{background:rgb(244,245,247);width:400px;height:180px}</style><div id="a"></div>');const shots:any[]=[];const receive=(e:any)=>{shots.push({at:e.metadata.timestamp,data:e.data});void c.send('Page.screencastFrameAck',{sessionId:e.sessionId})};c.on('Page.screencastFrame',receive);await c.send('Page.startScreencast',{format:'png',everyNthFrame:1});await page.waitForTimeout(100);shots.length=0;const begin=Date.now()/1000;
await page.evaluate(property=>document.getElementById('a')!.animate(property==='backgroundColor'?[{backgroundColor:'rgb(244,245,247)'},{backgroundColor:'oklch(50% .17 290)'}]:property==='height'?[{height:'180px'},{height:'40px'}]:[{transform:'translateX(0)'},{transform:'translateX(100px)'}],{duration:1000,easing:'linear',fill:'forwards'}),property);
await page.waitForTimeout(180);const blockedAt=Date.now()/1000;await page.evaluate(()=>{const until=performance.now()+500;while(performance.now()<until){}});const unblockedAt=Date.now()/1000;await page.waitForTimeout(400);await c.send('Page.stopScreencast');c.off('Page.screencastFrame',receive);const files=shots.map((s,i)=>{const file=property+'-'+String(i).padStart(3,'0')+'.png';writeFileSync(dir+'/'+file,Buffer.from(s.data,'base64'));return{file,ms:Math.round((s.at-begin)*1000),duringBlock:s.at>=blockedAt&&s.at<unblockedAt}});writeFileSync(dir+'/'+property+'.json',JSON.stringify({block:[Math.round((blockedAt-begin)*1000),Math.round((unblockedAt-begin)*1000)],files},null,2));console.log(property,files.filter(s=>s.duringBlock));
}
}finally{await browser.close()}
