#!/usr/bin/env python3
"""周报生成器（演示用）：把纯文本工作记录整理成三段式周报草稿。"""
import sys


def main() -> None:
    text = sys.stdin.read().strip()
    if not text:
        print("用法: echo \"工作记录...\" | python3 scripts/weekly.py")
        return
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    done = [ln for ln in lines if ln.startswith(("完成", "做了", "搞定"))]
    doing = [ln for ln in lines if ln.startswith(("在做", "推进", "进行"))]
    risks = [ln for ln in lines if ln.startswith(("风险", "阻塞", "需要"))]

    def render(title: str, items: list[str], fallback: str) -> str:
        if not items:
            return f"## {title}\n- {fallback}\n"
        return f"## {title}\n" + "".join(f"- {ln}\n" for ln in items)

    print(render("本周完成", done, "（未提供，待补充）"))
    print(render("进行中", doing, "（未提供，待补充）"))
    print(render("风险与需要的支持", risks, "无"))


if __name__ == "__main__":
    main()
