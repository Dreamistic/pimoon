"""标准 subprocess.run 的受控文本子集；真实创建、审批与回收仍走执行服务。"""
import base64
import locale
import os
import subprocess
import sys


# 不使用 UTF-8 模式下的首选编码，保留 Windows 实际本地代码页。
LOCAL_ENCODING = locale.getencoding() if os.name == "nt" else None


class ProcessOutputDecodeError(UnicodeError):
    """解码失败不代表进程未执行；原始输出与退出事实可供排查。"""
    def __init__(self, result):
        super().__init__(result["decode_error"])
        self.stdout = base64.b64decode(result["stdout_base64"])
        self.stderr = base64.b64decode(result["stderr_base64"])
        self.returncode = result["exit_code"]
        self.status = result["status"]


def install(bridge, enabled, failed):
    def prepare(args, *, cwd=None, env=None, timeout=None, check=False, capture_output=False,
            text=False, encoding=None, stdout=None, stderr=None, shell=False, **unsupported):
        if not enabled():
            raise PermissionError("subprocess.run is not enabled")
        if type(check) is not bool:
            raise TypeError("check must be a bool")
        if timeout is not None and (type(timeout) not in (int, float) or not 0 < timeout <= 1800):
            raise ValueError("timeout must be > 0 and <= 1800 seconds")
        if encoding is not None and (type(encoding) is not str or not encoding):
            raise TypeError("encoding must be a nonempty charset name")
        if unsupported:
            raise TypeError("Unsupported subprocess.run options: " + ", ".join(unsupported))
        if shell or type(args) not in (list, tuple) or not args or any(type(arg) is not str for arg in args):
            raise ValueError("Use subprocess.run with a nonempty string argv list; shell is disabled")
        if capture_output and (stdout is not None or stderr is not None):
            raise ValueError("stdout/stderr cannot be combined with capture_output")
        if capture_output:
            stdout = stderr = subprocess.PIPE
        if stdout not in (None, subprocess.PIPE, subprocess.DEVNULL) or stderr not in (None, subprocess.PIPE, subprocess.DEVNULL):
            raise ValueError("stdout/stderr support PIPE, DEVNULL or the default stream")
        if (stdout == subprocess.PIPE or stderr == subprocess.PIPE) and not (text or encoding is not None):
            raise ValueError("Captured process output requires text=True or encoding")
        input_args = {"argv": list(args), "check": False}
        if encoding is not None:
            input_args["encoding"] = encoding
        elif LOCAL_ENCODING:
            input_args["fallback_encoding"] = LOCAL_ENCODING
        if stdout == subprocess.DEVNULL:
            input_args["discard_stdout"] = True
        if stderr == subprocess.DEVNULL:
            input_args["discard_stderr"] = True
        if cwd is not None:
            input_args["cwd"] = os.fspath(cwd)
        if env is not None:
            input_args.update(env=dict(env), inherit_env=False)
        if timeout is not None:
            input_args["timeout"] = timeout
        if env is not None and any(type(k) is not str or type(v) is not str for k, v in input_args["env"].items()):
            raise TypeError("env keys and values must be strings")
        return input_args, {"args": args, "timeout": timeout, "check": check, "stdout": stdout, "stderr": stderr}

    def finish(result, options, *, report=True):
        args, timeout, check, stdout, stderr = (options[key] for key in ("args", "timeout", "check", "stdout", "stderr"))
        if type(result) is not dict:
            raise RuntimeError("Invalid process result; do not replay potentially completed operations")
        if result.get("feedback"):
            sys.stderr.write(result["feedback"] + "\n")
        out, err = result["stdout"], result["stderr"]
        if result["truncated"]:
            err += "\n[process output truncated; narrow output, do not replay completed side effects]"
        status = result["status"]
        if status != "exited":
            if report:
                failed("Process " + status + ": " + err[:600])
            if status == "timeout":
                raise subprocess.TimeoutExpired(args, result.get("timeout", timeout or 300), output=base64.b64decode(result["stdout_base64"]) if "stdout_base64" in result else out.encode("utf-8"),
                    stderr=base64.b64decode(result["stderr_base64"]) if "stderr_base64" in result else err.encode("utf-8"))
            if status == "spawn_error":
                raise OSError(err)
            raise RuntimeError("Process " + status)
        if result.get("decode_error"):
            if report:
                failed(result["decode_error"][:600])
            raise ProcessOutputDecodeError(result)
        captured_out = out if stdout == subprocess.PIPE else None
        captured_err = err if stderr == subprocess.PIPE else None
        if stdout is None:
            sys.stdout.write(out)
        if stderr is None:
            sys.stderr.write(err)
        if check and result["exit_code"] != 0:
            if report:
                failed("Process exited " + str(result["exit_code"]) + ": " + err[:600])
            raise subprocess.CalledProcessError(result["exit_code"], args, output=captured_out, stderr=captured_err)
        return subprocess.CompletedProcess(args, result["exit_code"], captured_out, captured_err)

    def run(args, **kwargs):
        input_args, options = prepare(args, **kwargs)
        return finish(bridge("call", name="process_run", args=input_args), options)

    subprocess.run = run
    return subprocess, prepare, finish
