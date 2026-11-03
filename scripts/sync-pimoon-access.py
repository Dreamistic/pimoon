"""只同步当前有效的访问凭据；不使用或复制刷新令牌，不触发刷新。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, default=Path.home() / '.pi/agent')
parser.add_argument('--home', type=Path, default=Path(os.environ.get('PIMOON_HOME', str(Path(os.environ.get('APPDATA', str(Path.home()))) / 'pimoon'))))
parser.add_argument('--replace', action='store_true', help='明确替换 pimoon 自己的访问凭据副本')
args = parser.parse_args()
source = args.source / 'auth.json'
before = hashlib.sha256(source.read_bytes()).digest()
credential = json.loads(source.read_text(encoding='utf-8'))['openai-codex']
if credential.get('type') != 'oauth' or credential.get('expires', 0) < (time.time() + 600) * 1000:
    raise SystemExit('源访问凭据已过期或不足十分钟。请先在原版正常登录；此工具不会刷新。')
agent = args.home.resolve() / 'agent'
if agent.resolve() == args.source.resolve():
    raise SystemExit('目标不能是凭据来源目录。')
agent.mkdir(parents=True, exist_ok=True)
if (agent / 'auth.json').exists() and not args.replace:
    raise SystemExit('pimoon 已有访问凭据，未覆盖。需要同步时显式指定 --replace。')
if os.name == 'nt':
    account = os.environ['USERDOMAIN'] + chr(92) + os.environ['USERNAME']
    result = subprocess.run(['icacls', str(agent), '/inheritance:r', '/grant:r', account + ':(OI)(CI)F'], capture_output=True)
    if result.returncode:
        raise SystemExit('凭据目录权限设置失败，未写入凭据。')
copied = {key: credential[key] for key in ['type', 'access', 'expires', 'accountId']}
copied['refresh'] = 'DISABLED_IN_PIMOON_COPY'
(agent / 'auth.json').write_text(json.dumps({'openai-codex': copied}), encoding='utf-8')
store = json.loads((args.source / 'models-store.json').read_text(encoding='utf-8'))
if not (agent / 'models-store.json').exists():
    (agent / 'models-store.json').write_text(json.dumps({'openai-codex': store['openai-codex']}), encoding='utf-8')
assert hashlib.sha256(source.read_bytes()).digest() == before
print('pimoon 有效访问凭据副本已就绪；原登录与刷新令牌未修改。')
print('目标：', agent)
