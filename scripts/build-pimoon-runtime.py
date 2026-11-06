"""使用 PATH 或 PIMOON_RUST_BIN 中的 Rust 工具链编译执行器。"""
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
env = dict(os.environ)
if env.get("PIMOON_RUST_BIN"):
    env["PATH"] = env["PIMOON_RUST_BIN"] + os.pathsep + env.get("PATH", "")
cargo = shutil.which("cargo", path=env.get("PATH"))
rustc = shutil.which("rustc", path=env.get("PATH"))
if not cargo or not rustc:
    raise SystemExit("缺少 Rust 工具链：请安装 Rust stable，或将 PIMOON_RUST_BIN 指向含 cargo、rustc 的 bin 目录。")
env["RUSTC"] = rustc
env["CARGO_TARGET_DIR"] = str(ROOT / ".tmp/build/runtime")
for action in ["test", "build"]:
    subprocess.run([cargo, action, "--release", "--locked", "--offline", "--manifest-path", str(ROOT / "native/runtime/Cargo.toml")], env=env, check=True)
filename = "pimoon-runtime.exe" if os.name == "nt" else "pimoon-runtime"
(ROOT / "assets/runtime").mkdir(parents=True, exist_ok=True)
shutil.copy2(ROOT / ".tmp/build/runtime/release" / filename, ROOT / "assets/runtime" / filename)
print("pimoon 原生执行器已重新编译并完成 Rust 测试。")
