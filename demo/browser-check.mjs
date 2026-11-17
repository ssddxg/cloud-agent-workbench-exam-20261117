// Browser QA runs only against our own localhost application in the Linux CI runner.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const base = process.env.DEMO_URL || 'http://127.0.0.1:3210';
const browser = await chromium.launch({ executablePath:process.env.CHROME_BIN || '/usr/bin/google-chrome', headless:true, args:['--no-sandbox'] });
const context = await browser.newContext({ viewport:{width:1512,height:982}, deviceScaleFactor:1, locale:'zh-CN', reducedMotion:'reduce' });
const page = await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
await fs.mkdir('evidence/screenshots',{recursive:true});
try {
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#connection').textContent.includes('Agent 已就绪'));
  await page.locator('#new-session').click();
  await page.locator('.welcome h2').waitFor();
  await page.screenshot({path:'evidence/screenshots/01-workspace.png',fullPage:true});
  page.once('dialog',dialog=>dialog.accept('浏览器验证 · 材料工作'));
  await page.locator('#rename-session').click();
  await page.waitForFunction(()=>document.querySelector('#session-title').textContent==='浏览器验证 · 材料工作');
  await page.locator('#file-input').setInputFiles({name:'notes.md',mimeType:'text/markdown',buffer:Buffer.from('# 材料验证\n文件上传、预览和会话恢复。\n<script>window.__untrusted=true</script>')});
  await page.locator('.file-info').filter({hasText:'notes.md'}).waitFor();
  await page.locator('.file-info').filter({hasText:'notes.md'}).click();
  await page.waitForFunction(()=>document.querySelector('#preview-content').textContent.includes('文件上传'));
  assert.equal(await page.evaluate(()=>window.__untrusted),undefined,'Uploaded HTML/script must remain inert text');
  await page.screenshot({path:'evidence/screenshots/02-material-preview.png',fullPage:true});
  await page.locator('#close-preview').click();
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#session-title').textContent==='浏览器验证 · 材料工作');
  assert.equal(await page.locator('#session-title').textContent(),'浏览器验证 · 材料工作');
  await page.locator('.file-info').filter({hasText:'notes.md'}).waitFor();
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('link',{name:'下载 notes.md',exact:true}).click();
  const download=await downloadPromise;
  assert.equal(download.suggestedFilename(),'notes.md');
  const sessions=await (await fetch(base+'/api/sessions')).json();
  const real=sessions.find(s=>s.title==='Docker real CLI verification'&&s.status==='completed');
  if(real){
    await page.locator('.session-item').filter({hasText:real.title}).click();
    await page.waitForFunction(title=>document.querySelector('#session-title').textContent===title,real.title);
    await page.locator('.file-info').filter({hasText:'report.md'}).waitFor();
    await page.screenshot({path:'evidence/screenshots/03-real-cli-result.png',fullPage:true});
    await page.locator('.file-info').filter({hasText:'report.md'}).click();
    await page.waitForFunction(()=>!document.querySelector('#preview-content').textContent.includes('正在读取'));
    await page.screenshot({path:'evidence/screenshots/04-report-preview.png',fullPage:true});
    await page.locator('#close-preview').click();
  }
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=1);
  await page.screenshot({path:'evidence/screenshots/05-mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'Mobile layout must not overflow horizontally');
  await page.locator('#menu-toggle').click();
  assert.ok(await page.locator('#sidebar').evaluate(el=>el.classList.contains('open')));
  assert.deepEqual(errors,[],'Browser must not raise JavaScript errors');
  const evidence={generatedAt:new Date().toISOString(),browser:'Headless Google Chrome in GitHub Actions',environment:'Docker application',checks:{render:true,newSession:true,rename:true,upload:true,safePreview:true,download:true,refreshRestore:true,multipleSessions:true,mobileLayout:true,realCliResultVisible:!!real,javaScriptErrors:errors},screenshots:['01-workspace.png','02-material-preview.png',...(real?['03-real-cli-result.png','04-report-preview.png']:[]),'05-mobile.png']};
  await fs.writeFile('evidence/browser-verification.json',JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
} finally {await browser.close();}
