import { testUsesHTTPS } from './tls-proxy.mjs'
import { expect, test, type Page } from '@playwright/test'
import { startIsolatedServer } from './isolated-server'
const password='correct horse battery'
async function setup(page:Page,url:string,token:string){await page.goto(`${url}/setup#${token}`);await page.getByLabel('设置密码').fill(password);await page.getByLabel('再次输入密码').fill(password);await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check();await page.getByRole('button',{name:'创建加密云盘'}).click();await expect(page.getByRole('heading',{name:'我的文件',exact:true})).toBeVisible({timeout:30000})}
async function login(page:Page,url:string){await page.goto(`${url}/login`);await page.getByLabel('管理员用户名').fill('admin');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'解锁云盘',exact:true}).click();await expect(page.getByRole('heading',{name:'我的文件',exact:true})).toBeVisible({timeout:30000})}
async function folder(page:Page,name:string){page.once('dialog',dialog=>void dialog.accept(name));await page.getByRole('button',{name:'新建文件夹',exact:true}).click();await expect(page.getByRole('button',{name,exact:true})).toBeVisible();await expect(page.getByRole('status')).toContainText('文件夹已创建。',{timeout:30000})}
async function upload(page:Page,name:string,size=0){const buffer=size?Buffer.alloc(size,65):Buffer.from(`original ${name}`);await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({name,mimeType:'text/plain',buffer});await expect(page.getByRole('button',{name,exact:true})).toBeVisible({timeout:30000});await expect(page.getByRole('status')).toContainText('上传完成。',{timeout:30000});await expect(page.locator('input[type="file"]:not([webkitdirectory])').first()).toBeEnabled()}
const home=(page:Page)=>page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'我的文件',exact:true})
const trash=(page:Page)=>page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'回收站',exact:true})
const confirm=(page:Page)=>page.getByRole('dialog',{name:'将所选项目移到回收站',exact:true})
async function openFolder(page:Page,name:string){await page.getByRole('button',{name:`打开 ${name}`,exact:true}).click();await expect(page.getByRole('heading',{name,exact:true})).toBeVisible({timeout:30000})}
async function goHome(page:Page){await home(page).click();await expect(page.getByRole('heading',{name:'我的文件',exact:true})).toBeVisible({timeout:30000})}
async function select(page:Page,name:string){const checkbox=page.getByLabel(`选择 ${name}`,{exact:true});await checkbox.focus();await checkbox.press('Space');await expect(checkbox).toBeChecked()}
test('cross-directory ancestor/child selections use one transaction and independent roots, Delete cancels without writes and restores original bytes',async({page})=>{
 test.setTimeout(120000);const server=await startIsolatedServer()
 try{
  await setup(page,server.baseURL,server.token);await folder(page,'tree');await folder(page,'other');await upload(page,'keep.txt')
  await openFolder(page,'tree');await upload(page,'child.txt');await goHome(page)
  await select(page,'tree');await openFolder(page,'tree');await select(page,'child.txt');await goHome(page)
  await openFolder(page,'other');await upload(page,'separate.txt');await select(page,'separate.txt')
  const selected=page.getByRole('toolbar',{name:'批量操作'});await expect(selected).toContainText('已选 3 项')
  let writes=0;const transactions:Record<string,unknown>[]=[];page.on('request',request=>{if(['POST','PUT','DELETE'].includes(request.method()))writes++;if(request.method()==='POST'&&request.url().endsWith('/metadata/transactions'))transactions.push(request.postDataJSON())})
  const card=page.locator('.entry-card').first();await card.focus();await card.press('Delete');await expect(confirm(page)).toBeVisible();await expect(confirm(page).getByRole('button',{name:'取消',exact:true})).toBeFocused()
  await page.keyboard.press('Escape');await expect(confirm(page)).toHaveCount(0);await expect(card).toBeFocused();expect(writes).toBe(0)
  await selected.getByRole('button',{name:'移到回收站所选',exact:true}).click();await confirm(page).getByRole('button',{name:'确认移到回收站',exact:true}).click()
  await expect(page.getByRole('status')).toContainText('原子移到回收站。',{timeout:30000});await expect(page.getByRole('status')).toContainText('已将 2 个顶层项目原子移到回收站。',{timeout:30000});await expect(selected).toHaveCount(0)
  expect(transactions[0]!.updates).toHaveLength(3)
  await home(page).click();await expect(page.getByRole('button',{name:'tree',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'other',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'keep.txt',exact:true})).toBeVisible()
  await trash(page).click();await expect(page.getByRole('button',{name:'tree',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'separate.txt',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'child.txt',exact:true})).toHaveCount(0)
  await page.getByRole('button',{name:'恢复 tree',exact:true}).click();await expect(page.getByRole('button',{name:'tree',exact:true})).toHaveCount(0,{timeout:30000})
  await page.getByRole('button',{name:'恢复 separate.txt',exact:true}).click();await expect(page.getByRole('button',{name:'separate.txt',exact:true})).toHaveCount(0,{timeout:30000})
  await goHome(page);await page.getByRole('button',{name:'tree',exact:true}).click();await expect(page.getByRole('heading',{name:'tree',exact:true})).toBeVisible();await page.getByRole('button',{name:'child.txt',exact:true}).click();await expect(page.getByRole('dialog',{name:'预览 child.txt'})).toContainText('original child.txt')
 }finally{await server.close()}
})
test('a renamed confirmed item rejects the entire batch before writes; lock during traversal cancels staged work without deletion',async({page})=>{
 test.setTimeout(120000);const server=await startIsolatedServer();const peer=await page.context().browser()!.newContext({ ignoreHTTPSErrors: testUsesHTTPS() });const remote=await peer.newPage()
 try{
  await setup(page,server.baseURL,server.token);await upload(page,'one.txt');await upload(page,'two.txt');await login(remote,server.baseURL)
  await page.getByLabel('选择 one.txt',{exact:true}).check();await page.getByLabel('选择 two.txt',{exact:true}).check();await page.getByRole('button',{name:'移到回收站所选',exact:true}).click()
  await remote.getByRole('button',{name:'更多操作 two.txt',exact:true}).click();remote.once('dialog',dialog=>void dialog.accept('renamed.txt'));await remote.getByRole('button',{name:'重命名 two.txt',exact:true}).click();await expect(remote.getByRole('button',{name:'renamed.txt',exact:true})).toBeVisible()
  let writes=0;page.on('request',request=>{if(['POST','PUT','DELETE'].includes(request.method()))writes++})
  await confirm(page).getByRole('button',{name:'确认移到回收站',exact:true}).click();await expect(page.getByText('已选项目已改名、移动、被覆盖或删除，请重新选择。',{exact:true})).toBeVisible();expect(writes).toBe(0)
  await home(page).click();await page.getByRole('button',{name:'取消选择',exact:true}).click();await page.getByLabel('选择 one.txt',{exact:true}).check()
  let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve});let held=false, buildStarted=false
  page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/v1/tombstone-builds'))buildStarted=true})
  await page.route('**/api/v1/objects/*',async route=>{if(!buildStarted){await route.continue();return};held=true;await hold;await route.continue().catch(()=>{})})
  await page.getByRole('button',{name:'移到回收站所选',exact:true}).click();await confirm(page).getByRole('button',{name:'确认移到回收站',exact:true}).click();await expect.poll(()=>held).toBe(true)
  await page.getByRole('button',{name:'锁定云盘',exact:true}).click();release();await expect(page.locator('body')).not.toContainText('one.txt')
  await page.unroute('**/api/v1/objects/*');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'解锁云盘',exact:true}).click();await expect(page.getByRole('button',{name:'one.txt',exact:true})).toBeVisible({timeout:30000});await expect(page.getByRole('button',{name:'renamed.txt',exact:true})).toBeVisible();await expect(page.getByRole('toolbar',{name:'批量操作'})).toHaveCount(0)
 }finally{await peer.close();await server.close()}
})
test('full ordinary quota batches two parents through the same precharged maintenance transaction and replays a lost response',async({page})=>{
 test.setTimeout(120000);const server=await startIsolatedServer({quotaBytes:200*1024,maintenanceReserveBytes:16384})
 try{
  await setup(page,server.baseURL,server.token);await folder(page,'a');await folder(page,'b');await upload(page,'capacity-sentinel.bin',64*1024)
  await openFolder(page,'a');await upload(page,'one.txt');await select(page,'one.txt');await goHome(page)
  await openFolder(page,'b');await upload(page,'two.txt');await select(page,'two.txt')
  const usage=()=>page.evaluate(async()=>await(await fetch('/api/v1/storage/usage')).json() as {usedBytes:number;reservedBytes:number;quotaBytes:number;maintenanceReservedBytes:number;pendingBytes:number;uploadReservedBytes:number;availableBytes:number})
  const before=await usage();expect(before.pendingBytes).toBe(0);expect(before.uploadReservedBytes).toBe(0);await server.restartWithQuota(before.usedBytes+before.maintenanceReservedBytes)
  const full=await usage();expect(full.availableBytes).toBe(0);let puts=0;const bodies:string[]=[],keys:string[]=[];page.on('request',request=>{if(request.method()==='PUT')puts++})
  await page.route('**/api/v1/metadata/maintenance-trash',async route=>{bodies.push(route.request().postData()!);keys.push(route.request().headers()['idempotency-key']!);if(bodies.length===1){const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed')}else await route.continue()})
  await page.getByRole('button',{name:'移到回收站所选',exact:true}).click();await confirm(page).getByRole('button',{name:'确认移到回收站',exact:true}).click();await expect(page.getByRole('status')).toContainText('原子移到回收站。',{timeout:30000});await expect(page.getByRole('status')).toContainText('已将 2 个顶层项目原子移到回收站。',{timeout:30000})
  expect(puts).toBe(0);expect(bodies).toHaveLength(2);expect(new Set(keys).size).toBe(1);expect(new Set(bodies).size).toBe(1)
  const body=JSON.parse(bodies[0]!) as {finalizeTombstoneBuilds:unknown[];updates:unknown[];encryptedObjects:string[]};expect(body.finalizeTombstoneBuilds).toHaveLength(2);expect(body.updates).toHaveLength(3)
  const added=body.encryptedObjects.reduce((sum,item)=>sum+Buffer.from(item,'base64').length,0),after=await usage();expect(after.usedBytes).toBe(full.usedBytes+added);expect(after.maintenanceReservedBytes).toBe(full.maintenanceReservedBytes-added);expect(after.usedBytes+after.reservedBytes).toBe(after.quotaBytes);expect(after.pendingBytes).toBe(0);expect(after.uploadReservedBytes).toBe(0)
  await trash(page).click();await expect(page.getByRole('button',{name:'one.txt',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'two.txt',exact:true})).toBeVisible()
 }finally{await server.close()}
})
