"""标准 subprocess.run 的受控文本子集；真实创建、审批与回收仍走执行服务。"""
import os
import subprocess
import sys


def install(bridge, enabled, failed):
    def prepare(args, *, cwd=None, env=None, timeout=None, check=False, capture_output=False,
            text=False, stdout=None, stderr=None, shell=False, **unsupported):
        if not enabled():
            raise PermissionError("subprocess.run is not enabled")
        if type(check) is not bool:
            raise TypeError("check must be a bool")
        if timeout is not None and (type(timeout) not in (int, float) or not 0 < timeout <= 1800):
            raise ValueError("timeout must be > 0 and <= 1800 seconds")
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
        if (stdout == subprocess.PIPE or stderr == subprocess.PIPE) and not text:
            raise ValueError("Captured process output requires text=True (UTF-8)")
        input_args = {"argv": list(args), "check": False}
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
                raise subprocess.TimeoutExpired(args, result.get("timeout", timeout or 300), output=out.encode("utf-8"), stderr=err.encode("utf-8"))
            if status == "spawn_error":
                raise OSError(err)
            raise RuntimeError("Process " + status)
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
