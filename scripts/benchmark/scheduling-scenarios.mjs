import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {scenarios as existing} from './tool-scenarios.mjs';
const processScript=`import fs from 'node:fs';
fs.appendFileSync('executions.txt',process.argv[2]+'\\n');
if(process.argv[2]==='fail'){console.error('fixture-failure');process.exit(7);}
console.log(JSON.parse(fs.readFileSync('numbers.json','utf8')).reduce((a,b)=>a+b,0));
`;
const files=['api','cache','database','logging','queue','worker'];
export const scenarios={
 'independent-review':{
  prompt:'检查 services 下 api、cache、database、logging、queue、worker 六份 .txt 配置说明，找出 enabled=true 且 retries<3 的服务。将服务名按字典序写入 review.json 数组，不改说明文件，最后简短报告结果。',
  async setup(cwd){
   await fs.mkdir(path.join(cwd,'services'));
   for(const [index,name] of files.entries())await fs.writeFile(path.join(cwd,'services',name+'.txt'),`service=${name}\nenabled=${index%2===0}\nretries=${index%4}\n`);
  },
  async verify(cwd){
   assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd,'review.json'),'utf8')),['api','database','queue']);
   for(const [index,name] of files.entries())assert.equal(await fs.readFile(path.join(cwd,'services',name+'.txt'),'utf8'),`service=${name}\nenabled=${index%2===0}\nretries=${index%4}\n`);
   assert.deepEqual((await fs.readdir(cwd)).sort(),['review.json','services']);
  },
 },
 'process-check':{
  prompt:`使用当前执行环境，通过 Node 程序（可执行文件 ${process.execPath}）分别运行 check.mjs 的 ok 和 fail 模式，各一次。读取退出码、标准输出和标准错误；fail 退出非零是预期，不应阻止完成。把两次结果写入 process-result.json，格式为 {"ok":{"returncode":整数,"stdout":字符串,"stderr":字符串},"fail":同结构}。不要只用 Python 代算，不改 check.mjs 或 numbers.json，不重放已完成的命令。最后重新读取结果确认。`,
  async setup(cwd){await fs.writeFile(path.join(cwd,'check.mjs'),processScript);await fs.writeFile(path.join(cwd,'numbers.json'),'[20,22]');},
  async verify(cwd){
   assert.equal(await fs.readFile(path.join(cwd,'check.mjs'),'utf8'),processScript);assert.equal(await fs.readFile(path.join(cwd,'numbers.json'),'utf8'),'[20,22]');
   assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd,'process-result.json'),'utf8')),{ok:{returncode:0,stdout:'42\n',stderr:''},fail:{returncode:7,stdout:'',stderr:'fixture-failure\n'}});
   assert.deepEqual((await fs.readFile(path.join(cwd,'executions.txt'),'utf8')).trim().split('\n').sort(),['fail','ok']);
  },
 },
 'locate-edit':existing['locate-edit'],
 'conditional-edit':existing['conditional-edit'],
};
