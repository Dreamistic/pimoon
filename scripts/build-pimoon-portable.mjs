// 在源码构建完成后封装独立 Windows 目录；不改动 Electron 来源目录。
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const source=process.env.PIMOON_ELECTRON_DIST ?? 'D:/Program/o-pi/app';
const output=path.resolve('dist/pimoon');
await fs.mkdir(output,{recursive:true});
for(const item of await fs.readdir(source,{withFileTypes:true})) {
 if(item.name==='resources')continue;
 const name=item.name.endsWith('.exe')?'pimoon.exe':item.name;
 await fs.cp(path.join(source,item.name),path.join(output,name),{recursive:true});
}
await fs.mkdir(path.join(output,'resources'),{recursive:true});
await fs.cp('dist/desktop/app',path.join(output,'resources/app'),{recursive:true});
execFileSync(path.resolve('node_modules/electron-winstaller/vendor/rcedit.exe'),[
 path.join(output,'pimoon.exe'),'--set-icon',path.resolve('assets/icons/icon.ico'),
 '--set-version-string','ProductName','pimoon','--set-version-string','FileDescription','pimoon',
 '--set-version-string','CompanyName','Dream','--set-version-string','OriginalFilename','pimoon.exe',
 '--set-version-string','LegalCopyright','pimoon modifications by Dream; upstream notices in resources',
 '--set-file-version','0.1.0','--set-product-version','0.1.0',
]);
console.log('独立应用已封装：'+path.join(output,'pimoon.exe'));
