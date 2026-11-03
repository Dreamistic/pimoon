"""生成本地元数据摘要和可选事件时间线，不读取会话正文或访问凭据。"""
import argparse
import json
import os
from pathlib import Path
from pimoon_report import build_report, markdown


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('PIMOON_HOME', str(Path(os.environ.get('APPDATA', str(Path.home()))) / 'pimoon'))))
    parser.add_argument('--run', help='只分析指定应用运行 ID')
    parser.add_argument('--session', help='只分析指定会话 ID')
    parser.add_argument('--agent', help='只分析指定轮次 ID')
    parser.add_argument('--timeline', action='store_true', help='包含逐项批处理、状态恢复等事件时间线')
    parser.add_argument('--format', choices=['json', 'markdown'], default='json')
    args = parser.parse_args()
    report = build_report(args.home, args.run, args.session, args.agent, args.timeline)
    print(markdown(report) if args.format == 'markdown' else json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
