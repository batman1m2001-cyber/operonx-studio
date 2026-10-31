"""The assistant's transcript render time on a running studio
(docs/VISUAL_CHAT_PLAN.md V0, V7): opens a conversation, re-renders it
five times, and reports the median of assistant.js's ``ax:render`` measure,
the long tasks seen, and the transcript's DOM size.

usage: render_chat.py <base> <project id> <session id> [--width 1440]
"""
import argparse
import asyncio
import json
import statistics

from playwright.async_api import async_playwright


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("project")
    ap.add_argument("session")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--exe", default=None, help="a chromium binary, when playwright's own is not installed")
    a = ap.parse_args()
    async with async_playwright() as p:
        b = await p.chromium.launch(**({"executable_path": a.exe} if a.exe else {}))
        ctx = await b.new_context(viewport={"width": a.width, "height": 900})
        await ctx.add_init_script(f"localStorage.setItem('ax:{a.project}:current', {json.dumps(json.dumps(a.session))})")
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)[:200]))
        await pg.goto(f"{a.base}/p/{a.project}/project/now")
        await pg.wait_for_function("performance.getEntriesByName('ax:render').length > 0", timeout=60000)
        got = await pg.evaluate("""async (sid) => {
          const long = [];
          new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(Math.round(e.duration))))
            .observe({type: 'longtask'});
          for (let i = 0; i < 5; i++) {
            const before = performance.getEntriesByName('ax:render').length;
            window.oxAssistant.open(sid);
            while (performance.getEntriesByName('ax:render').length === before) await new Promise((r) => setTimeout(r, 20));
            await new Promise((r) => setTimeout(r, 150));
          }
          const runs = performance.getEntriesByName('ax:render').slice(-5);
          const log = document.querySelector('.ax-log');
          return {ms: runs.map((e) => +e.duration.toFixed(1)), items: runs[0].detail, long,
                  nodes: log ? log.querySelectorAll('*').length : 0};
        }""", a.session)
        got["median_ms"] = statistics.median(got["ms"])
        got["errors"] = errors
        print(json.dumps(got))
        await b.close()


if __name__ == "__main__":
    asyncio.run(main())
