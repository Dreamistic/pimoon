"""仅用已有 Rust 工具链离线编译本机执行器。"""
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
toolchain = Path(os.environ.get('PIMOON_RUST_BIN', 'D:/Code/githubproject/Agent/.tmp/tests/file-tools/toolchain/rustup/toolchains/stable-x86_64-pc-windows-gnu/bin'))
rustc = shutil.which('rustc') or str(toolchain / 'rustc.exe')
cargo = shutil.which('cargo') or str(toolchain / 'cargo.exe')
env = dict(os.environ, RUSTC=rustc, CARGO_HOME=str(ROOT / '.tmp/cargo'), CARGO_TARGET_DIR=str(ROOT / '.tmp/build/runtime'))
env['PATH'] = str(Path(rustc).parent) + os.pathsep + env.get('PATH', '')
for action in ['test', 'build']:
    subprocess.run([cargo, action, '--release', '--offline', '--manifest-path', str(ROOT / 'native/runtime/Cargo.toml')], env=env, check=True)
filename = 'pimoon-runtime.exe' if os.name == 'nt' else 'pimoon-runtime'
(ROOT / 'assets/runtime').mkdir(parents=True, exist_ok=True)
shutil.copy2(ROOT / '.tmp/build/runtime/release' / filename, ROOT / 'assets/runtime' / filename)
print('pimoon 原生执行器已重新编译并完成 Rust 测试。')
