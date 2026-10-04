#!/usr/bin/env python3
"""Build Japanese HTML/PDF reports from Playwright JSON and asserted evidence.

Requires Python 3.10+ and reportlab; never starts services or captures evidence.
"""

from __future__ import annotations

import argparse
import base64
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import html
from io import BytesIO
import json
import math
import os
from pathlib import Path
import re
import sys
from urllib.parse import quote


TITLE = "ローカル合成データによる E2E 受け入れ確認と機能デモ"
SCOPE = [
    "今回の範囲：scripted LLM、Firestore emulator、dev identity、および新規作成した合成テストアカウント。開発用の ID は、保護者の本人確認が済んでいることを意味しません。",
    "実際の Gemini、Gemini Live、FCM、SMS、email、OAuth、クラウド上の削除はいずれも未検証です。ローカルの通知記録は、実際に配信できたことを意味しません。",
    "削除エンドポイントが HTTP 202 を返すのはリクエストを受け付けたことだけを示し、クラウドストレージ、バックアップ、外部システムのデータがすべて削除されたことの証明にはなりません。",
    "保護者が危機通知を既読にしても、危機が終わったことにも、現実の対応が行われたことにもなりません。",
    "安全性テストはエンジニアリング上の仕組みだけを検証し、臨床的な有効性、モデルの精度、実際の子どもを守る効果は検証しません。",
    "ローカルモードは実際の子どもには使わず、実際の子どもの身元、会話、機微な情報は入力しません。モバイルのプロジェクトはブラウザーによる端末エミュレーションであり、実機での受け入れ確認ではありません。",
]
METHOD = (
    "論理テストケースはファイル、行、列、ケース名で重複を除き、プロジェクトやリトライの違いでは加算しません。プロジェクト実行は spec.tests の各エントリーを1件と数え、"
    "mobile と desktop は別々に示し、repeatEach で生じたエントリーもそれぞれ数えます。試行数にはリトライを含みます。"
    "「成功」は最終的に実際に成功し、かつ Playwright が想定どおりと判定した場合に限ります。リトライ後に成功したものは別途「不安定」として記録します。"
    "想定どおりの失敗は別枠で示し、成功には数えません。中断、未実行、不明な状態も成功には数えません。"
    "論理テストケースは、記載されたプロジェクト実行がすべて成功した場合だけ「すべて成功」とし、JSON に載っていないプロジェクトやケースのカバレッジは推定しません。"
)
EVIDENCE_METHOD = (
    "エビデンスは、親のテストフローが実ブラウザーでのアサーションに成功したあとに生成します。この生成スクリプトは入力ファイルを収録するだけで、アサーションを再実行せず、"
    "スクリーンショットの見た目からテストの成否を判定することもありません。スクリーンショットは成功したステップのものであり、そのケース全体があとで失敗している場合もあります。"
    "紐づけには project と testTitle を使います。名前が一致しても、そのスクリーンショットが最後のリトライや同じ実行のものだとは証明できません。"
    "元のマニフェストのパス、画像の SHA-256、JSON の SHA-256 はエビデンスの照合に使い、目視確認は親のテストフローが行います。"
)
COVERAGE_METHOD = (
    "今回のテストの取り決めでは、タイトルが API audit で始まるケースを「API のみ」とし、それ以外を browser+API / UI（ブラウザーが関与するもの。"
    "UI の契約やレイアウトの確認を含み、すべてのケースに API のアサーションがあるとは限らず、完全なユーザージャーニーを意味するものでもありません）とします。"
    "API のみのケースを別のプロジェクトで繰り返し実行しても、ブラウザーのカバレッジは増えません。プロジェクト名は実行設定を示すだけで、物理的な端末を表しません。"
    "一部のレイアウトのケースはテスト内で viewport を独自に設定するため、すべての実行を統一されたモバイル／デスクトップのビューポート表として読むことはできません。"
    "デモの実際のビューポートは各エビデンスの viewport に従います。過去のベースラインや途中の再実行は背景情報であり、今回の集計には含めません。"
)
KIND = {"api": "API のみ", "browser": "browser+API / UI"}
FILE_COVERAGE = {
    "account-onboarding": "登録・ペアリング・撤回",
    "api-flows": "業務フローの一巡、記憶、音声のフォールバック、レイアウト",
    "device-functional": "端末での読み上げと位置情報のプライバシー",
    "flows": "子ども側の基本アクティビティとペットロック",
    "guardian-functional": "保護者側のコンテキスト情報、週次レポート、設定、通知",
    "help-offline": "相談窓口とオフライン用の相談先",
    "shared-artworks-functional": "作品の共有と取り消し",
    "report-audit": "権限、同意、ネガティブ監査、画面の回帰テスト",
    "report-journeys": "スクリーンショット付きの7つの通しデモ",
}
REPRO_COMMAND = (
    "LOCAL_PORT_OFFSET=800 E2E_REPORT_ROOT=../../artifacts/e2e-final-2026-10-02 "
    "pnpm --filter @ijime/child-web exec playwright test --config playwright.report.config.ts"
)
STATUS = {
    "passed": "成功", "failed": "失敗", "skipped": "スキップ",
    "expected_failure": "想定どおりの失敗", "incomplete": "未完了／不明",
}
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def text(value):
    if value is None:
        return "記載なし"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return ANSI.sub("", str(value))


def escaped(value):
    return html.escape(text(value), quote=True)


def natural(value):
    return tuple((1, int(part)) if part.isdigit() else (0, part.casefold())
                 for part in re.split(r"(\d+)", str(value)))


def read_json(path):
    with path.open(encoding="utf-8-sig") as stream:
        return json.load(stream)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def error_text(error):
    if isinstance(error, dict):
        return text(error.get("stack") or error.get("message") or error.get("value") or error)
    return text(error)


def execution_status(test):
    results = test.get("results", [])
    final = results[-1].get("status") if results else None
    outcome = test.get("status")
    expected = test.get("expectedStatus", "passed")
    if final == "interrupted":
        return "incomplete"
    if outcome == "unexpected":
        return "failed"
    if outcome == "skipped" or (final == "skipped" and outcome != "unexpected"):
        return "skipped"
    if final == "passed" and expected == "passed" and outcome in ("expected", "flaky"):
        return "passed"
    if final == "failed" and expected == "failed" and outcome in ("expected", "flaky"):
        return "expected_failure"
    if final in ("failed", "timedOut"):
        return "failed"
    return "incomplete"


def flatten_executions(report):
    executions = []

    def visit(suite, parents):
        path = parents + ([suite["title"]] if suite.get("title") else [])
        for spec in suite.get("specs", []):
            file = spec.get("file", suite.get("file", "記載なし"))
            title = spec.get("title", "名称未設定のケース")
            logical = (file, spec.get("line", 0), spec.get("column", 0), title)
            for test in spec.get("tests", []):
                attempts = test.get("results", [])
                errors = []
                for attempt in attempts:
                    items = attempt.get("errors") or ([attempt["error"]] if attempt.get("error") else [])
                    for error in items:
                        detail = "試行 retry={}: {}".format(attempt.get("retry", "記載なし"), error_text(error))
                        if detail not in errors:
                            errors.append(detail)
                executions.append({
                    "ref": "E{:04d}".format(len(executions) + 1),
                    "logical": logical, "title": title,
                    "full_title": " › ".join(path + [title]),
                    "file": file, "line": spec.get("line", 0),
                    "project": test.get("projectName") or test.get("projectId") or "名称未設定のプロジェクト",
                    "project_id": test.get("projectId", ""),
                    "status": execution_status(test), "outcome": test.get("status", "記載なし"),
                    "expected": test.get("expectedStatus", "passed"),
                    "final": attempts[-1].get("status", "不明") if attempts else "未実行",
                    "attempts": attempts, "errors": errors,
                    "duration": sum(a.get("duration", 0) or 0 for a in attempts),
                    "flaky": test.get("status") == "flaky",
                    "annotations": test.get("annotations", []),
                    "kind": "api" if title.startswith("API audit") else "browser",
                    "viewport_override": (
                        "room, chat, settings and tell fit without horizontal overflow" in title
                        or "weekly/context/settings layout uses real projections without overflow" in title
                        or "chat keeps navigation, local notice and composer separate" in title
                    ),
                })
        for child in suite.get("suites", []):
            visit(child, path)

    for suite in report["suites"]:
        visit(suite, [])
    return executions


def summary(executions):
    counts = Counter(e["status"] for e in executions)
    counts["total"] = len(executions)
    counts["flaky"] = sum(e["flaky"] for e in executions)
    counts["attempts"] = sum(len(e["attempts"]) for e in executions)
    return counts


def viewport_text(viewport):
    if isinstance(viewport, dict) and "width" in viewport and "height" in viewport:
        return "{} × {} CSS px".format(viewport["width"], viewport["height"])
    return text(viewport)


def load_evidence(root, executions, warnings):
    from reportlab.lib.utils import ImageReader

    evidence = []
    required = {"id", "section", "title", "action", "expected", "actual", "note",
                "project", "url", "viewport", "screenshot", "testTitle"}
    manifests = sorted((root / "raw-results").rglob("evidence.json"), key=lambda p: natural(str(p)))
    for manifest in manifests:
        rows = read_json(manifest)
        if not isinstance(rows, list):
            raise ValueError(f"{manifest}: オブジェクトの配列でなければなりません")
        for index, row in enumerate(rows, 1):
            if not isinstance(row, dict) or required - row.keys():
                raise ValueError(f"{manifest} の {index} 件目は必須フィールドが欠けているか、オブジェクトではありません")
            item = dict(row)
            item.update(source=str(manifest.relative_to(root)), source_index=index,
                        image=None, dimensions=None, image_error=None, sha256="利用できる画像なし")
            try:
                if not isinstance(row["screenshot"], str) or not row["screenshot"]:
                    raise ValueError("screenshot は空でないパスでなければなりません")
                path = Path(row["screenshot"])
                if not path.is_absolute():
                    path = (root / path).resolve()
                    if not path.is_relative_to(root):
                        raise ValueError("相対パスのスクリーンショットはレポートディレクトリの外を指せません")
                data = path.read_bytes()
                if data.startswith(b"\x89PNG\r\n\x1a\n"):
                    item["mime"] = "image/png"
                elif data.startswith(b"\xff\xd8\xff"):
                    item["mime"] = "image/jpeg"
                else:
                    raise ValueError("スクリーンショットは PNG または JPEG でなければなりません")
                reader = ImageReader(BytesIO(data))
                width, height = reader.getSize()
                reader.getRGBData()
                if width <= 0 or height <= 0:
                    raise ValueError("スクリーンショットのサイズが不正です")
                item.update(image=data, dimensions=(width, height), sha256=digest(data))
            except Exception as error:
                item["image_error"] = str(error)
                warnings.append(f"エビデンス {row['id']} ({row['project']}) のスクリーンショットを利用できません：{error}")
            item["matches"] = [e for e in executions
                               if row["project"] in (e["project"], e["project_id"])
                               and row["testTitle"] in (e["title"], e["full_title"])]
            if not item["matches"]:
                warnings.append(f"エビデンス {row['id']} ({row['project']}) をプロジェクトとタイトルで今回の JSON に紐づけられませんでした。")
            elif len(item["matches"]) > 1:
                warnings.append(f"エビデンス {row['id']} ({row['project']}) が複数の実行に紐づき、どの繰り返し実行のものか特定できません。")
            evidence.append(item)
    evidence.sort(key=lambda e: (natural(e["section"]), natural(e["id"]), natural(e["project"]),
                                 natural(e["source"]), e["source_index"]))
    for index, item in enumerate(evidence, 1):
        item["number"] = index
    if not evidence:
        warnings.append("root/raw-results に evidence.json のエビデンスがありません。このレポートにはスクリーンショットによるデモのエビデンスがありません。")
    return evidence


def load_model(root, results):
    raw = results.read_bytes()
    report = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(report, dict) or not isinstance(report.get("suites"), list):
        raise ValueError("--results は Playwright JSON reporter の出力で、suites 配列を含んでいなければなりません")
    warnings = []
    executions = flatten_executions(report)
    counts = summary(executions)
    stats = report.get("stats", {})
    outcomes = Counter(e["outcome"] for e in executions)
    for key in ("expected", "unexpected", "flaky", "skipped"):
        if key not in stats:
            warnings.append(f"Playwright stats に {key} がありません。このレポートは suites 内の実行エントリーで集計します。")
        elif stats[key] != outcomes[key]:
            warnings.append(f"集計の不一致：stats.{key}={stats[key]}、実行エントリーの件数={outcomes[key]}。")
    if not executions:
        warnings.append("JSON にプロジェクト実行がないため、E2E の成功は宣言できません。")
    logical = defaultdict(list)
    for execution in executions:
        logical[execution["logical"]].append(execution)
    logical_counts = Counter()
    for rows in logical.values():
        states = {e["status"] for e in rows}
        state = ("failed" if "failed" in states else "incomplete" if "incomplete" in states
                 else "passed" if states == {"passed"} else "skipped" if states == {"skipped"}
                 else "expected_failure" if states == {"expected_failure"} else "mixed")
        logical_counts[state] += 1
    configured = [p.get("name") or p.get("id") or "名称未設定のプロジェクト"
                  for p in report.get("config", {}).get("projects", [])]
    project_names = sorted(set(configured) | {e["project"] for e in executions}, key=natural)
    projects = [(name, summary([e for e in executions if e["project"] == name])) for name in project_names]
    evidence = load_evidence(root, executions, warnings)
    review_path = root / "review-notes.json"
    review = read_json(review_path) if review_path.exists() else {}
    if not isinstance(review, dict) or not isinstance(review.get("findings", []), list) or not isinstance(review.get("runNotes", []), list):
        raise ValueError("review-notes.json には findings 配列と runNotes 配列が必要です")
    for finding in review.get("findings", []):
        if not isinstance(finding, dict) or not {"severity", "title", "detail"} <= finding.keys():
            raise ValueError("review-notes.json の各 finding には severity/title/detail が必要です")
    if any(not isinstance(note, str) for note in review.get("runNotes", [])):
        raise ValueError("review-notes.json の runNotes の各要素は文字列でなければなりません")
    errors = [error_text(error) for error in report.get("errors", [])]
    if errors or counts["failed"]:
        verdict = "今回は失敗があるため、すべての受け入れ確認に合格したとは判定できません。"
    elif counts["incomplete"] or not executions:
        verdict = "今回は結果が不完全なため、すべての受け入れ確認に合格したとは判定できません。"
    elif counts["skipped"] or counts["expected_failure"] or counts["flaky"]:
        verdict = "今回は最終的な失敗はありませんが、スキップ、想定どおりの失敗、またはリトライによる不安定な実行があるため、カバレッジと安定性を個別に確認する必要があります。"
    else:
        verdict = "今回の JSON に記載されたプロジェクト実行はすべて成功しました。結論は上記のローカル合成データの範囲に限ります。"
    if warnings:
        verdict += " このレポートにはエビデンスまたはデータの完全性に関する注意があります。既知の不足点とあわせてお読みください。"
    if review.get("findings"):
        p2_count = sum(finding.get("status") != "resolved" and
                       bool(re.search(r"\bP2\b", text(finding["severity"]), re.IGNORECASE))
                       for finding in review["findings"])
        verdict += (f" 自動テストの成功は欠陥がないことを意味しません。人によるレビューで P2 の問題が {p2_count} 件残っています。詳細は既知の不足点を参照してください。"
                    if p2_count else " 自動テストの成功は欠陥がないことを意味しません。人によるレビューで別途指摘があります。詳細は既知の不足点を参照してください。")
    sections = defaultdict(list)
    for item in evidence:
        sections[text(item["section"])].append(item)
    return dict(root=root, results=results, results_sha=digest(raw), report=report,
                executions=executions, counts=counts, logical=logical, logical_counts=logical_counts,
                projects=projects, configured=configured, evidence=evidence, sections=sections,
                warnings=warnings, findings=review.get("findings", []),
                run_notes=review.get("runNotes", []), errors=errors, verdict=verdict,
                generated=datetime.now(timezone.utc).isoformat(timespec="seconds"))


def project_rows(model):
    return [[name, c["total"], c["passed"], c["failed"], c["skipped"], c["expected_failure"],
             c["incomplete"], c["flaky"], c["attempts"],
             sum(e["kind"] == "api" and e["project"] == name for e in model["executions"]),
             sum(e["kind"] == "browser" and e["project"] == name for e in model["executions"])]
            for name, c in model["projects"]]


PROJECT_HEADERS = ["プロジェクト", "実行", "成功", "失敗", "スキップ", "想定どおりの失敗", "未完了", "不安定", "試行", "API のみ", "ブラウザー関与"]


def coverage_rows(model):
    files = defaultdict(list)
    for execution in model["executions"]:
        files[execution["file"]].append(execution)
    rows = []
    for file, executions in sorted(files.items(), key=lambda pair: natural(pair[0])):
        basename = Path(file.replace("\\", "/")).name
        key = basename.removesuffix(".spec.ts").removesuffix(".spec.js")
        counts = summary(executions)
        rows.append([FILE_COVERAGE.get(key, "その他のテスト範囲（ケースの内容に従う）"), file,
                     len({e["logical"] for e in executions}), counts["total"],
                     counts["passed"], counts["failed"], counts["skipped"],
                     counts["expected_failure"] + counts["incomplete"]])
    return rows


COVERAGE_HEADERS = ["機能カバレッジ", "テストファイル", "論理テストケース", "実行", "成功", "失敗", "スキップ", "その他"]


def execution_rows(model):
    return [[e["ref"], f"{e['project']}\n{KIND[e['kind']]}", f"{e['full_title']}\n{e['file']}:{e['line']}",
             STATUS[e["status"]] + (" / リトライで不安定" if e["flaky"] else ""),
             f"想定 {e['expected']}\n実際 {e['final']}\n{e['outcome']}",
             f"{len(e['attempts'])} 回\n{e['duration'] / 1000:.2f} s"]
            for e in model["executions"]]


CASE_HEADERS = ["番号", "プロジェクト / 種別", "ケースと位置", "結果", "元のステータス", "試行／所要時間"]


def evidence_fields(item):
    matches = "、".join(f"{e['ref']} {STATUS[e['status']]}" for e in item["matches"]) or "紐づけなし。実行状態は推定しない"
    return [("操作", item["action"]), ("期待する結果", item["expected"]), ("実際の結果", item["actual"]),
            ("補足", item["note"] or "補足なし"), ("プロジェクト / ビューポート", f"{item['project']} / {viewport_text(item['viewport'])}"),
            ("ページ URL", item["url"]), ("関連ケース", item["testTitle"]), ("実行結果", matches),
            ("エビデンスのマニフェスト", f"{item['source']} の {item['source_index']} 件目"),
            ("元画像のパス", item["screenshot"]), ("画像 SHA-256", item["sha256"])]


def facts(model):
    c = model["counts"]
    stats = model["report"].get("stats", {})
    return [
        ("レポート生成日時 (UTC)", model["generated"]),
        ("テスト開始日時", stats.get("startTime")),
        ("全体の所要時間 (ms)", stats.get("duration")),
        ("プロジェクト数", f"設定 {len(set(model['configured']))}、JSON に実行が記載されているもの {sum(c['total'] > 0 for _, c in model['projects'])}"),
        ("論理テストケース", f"{len(model['logical'])}、記載された実行がすべて成功 {model['logical_counts']['passed']}、失敗を含む {model['logical_counts']['failed']}、未完了を含む {model['logical_counts']['incomplete']}、すべてスキップ {model['logical_counts']['skipped']}、すべて想定どおりの失敗 {model['logical_counts']['expected_failure']}、混在 {model['logical_counts']['mixed']}"),
        ("プロジェクト実行", f"{c['total']}、成功 {c['passed']}、失敗 {c['failed']}、スキップ {c['skipped']}、想定どおりの失敗 {c['expected_failure']}、未完了 {c['incomplete']}"),
        ("カバレッジの種別", "、".join(
            f"{label}：論理テストケース {len({e['logical'] for e in model['executions'] if e['kind'] == kind})} 件 / プロジェクト実行 {sum(e['kind'] == kind for e in model['executions'])} 件"
            for kind, label in KIND.items())),
        ("ビューポートを独自に設定する既知のレイアウトケース", f"論理テストケース {len({e['logical'] for e in model['executions'] if e['viewport_override']})} 件（ブラウザー関与に数えるが、統一されたプロジェクトのビューポートとは見なさない）"),
        ("リトライ", f"総試行数 {c['attempts']}、不安定な実行 {c['flaky']}（不安定は追加の目印であり、重複して合計しない）"),
        ("スクリーンショットのエビデンス", f"{len(model['evidence'])} 件、有効な画像 {sum(e['image'] is not None for e in model['evidence'])}"),
        ("元の Playwright stats", {k: stats.get(k) for k in ("expected", "unexpected", "flaky", "skipped")}),
        ("結果 JSON", str(model["results"])), ("結果 SHA-256", model["results_sha"]),
    ]


def failure_entries(model):
    entries = [("実行全体のエラー", error) for error in model["errors"]]
    for e in model["executions"]:
        if e["status"] not in ("failed", "incomplete") and not e["flaky"]:
            continue
        attempts = "; ".join(f"retry={a.get('retry', '?')}: {a.get('status', '不明')}" for a in e["attempts"]) or "実行結果なし"
        detail = f"{e['file']}:{e['line']}\n想定 {e['expected']}、最終的な実際の結果 {e['final']}、判定 {e['outcome']}\n{attempts}"
        detail += "\n" + ("\n\n".join(e["errors"]) if e["errors"] else "JSON にエラーの詳細がありません。")
        entries.append((f"{e['ref']} [{e['project']}] {e['title']}", detail))
    return entries


def artifact_links(model):
    links = []
    for execution in model["executions"]:
        for attempt in execution["attempts"]:
            for attachment in attempt.get("attachments", []):
                path_value = attachment.get("path")
                if not path_value:
                    continue
                path = Path(path_value)
                candidates = [path] if path.is_absolute() else [
                    model["results"].parent / path, model["root"] / path, path,
                ]
                relative = None
                for candidate in candidates:
                    resolved = candidate.resolve()
                    if resolved.is_file() and resolved.is_relative_to(model["root"]):
                        relative = resolved.relative_to(model["root"]).as_posix()
                        break
                label = "{} / retry={} / {}".format(execution["ref"], attempt.get("retry", "記載なし"),
                                                     attachment.get("name") or path.name)
                links.append((label, relative, str(path)))
    return links


CSS = """
:root{color-scheme:light;font-family:system-ui,-apple-system,'Hiragino Sans','Yu Gothic','Meiryo',sans-serif;color:#20262c;background:#f4f6f7;line-height:1.65}
*{box-sizing:border-box}body{margin:0}main{max-width:1180px;margin:auto;background:white;padding:36px}h1{font-size:30px;line-height:1.3}h2{font-size:23px;margin:0 0 20px}h3{font-size:19px;line-height:1.45}h4{font-size:17px}p,li,td,dd,h1,h2,h3,h4,a{overflow-wrap:anywhere}section{padding:32px 0;border-top:1px solid #dbe1e5;scroll-margin-top:16px}nav{padding:20px 0}nav ol{columns:2;column-gap:40px}nav li{break-inside:avoid;margin-bottom:7px}a{color:#125d83}a:focus-visible,button:focus-visible{outline:3px solid #b94e14;outline-offset:4px}.verdict{border-left:4px solid #087e68;padding:14px 18px;background:#edf7f3}.scope{border-left:4px solid #b94e14;padding-left:22px}.meta{color:#535e66;font-size:14px}.facts{display:grid;grid-template-columns:minmax(110px,170px) minmax(0,1fr);gap:9px 16px;margin:18px 0}dt{font-weight:650}dd{margin:0;min-width:0;white-space:pre-wrap}.table-scroll{overflow-x:auto;max-width:100%}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:10px 9px;text-align:left;vertical-align:top;border:1px solid #dbe1e5;white-space:pre-wrap}th{background:#edf2f4}tr:nth-child(even) td{background:#fafbfc}.cases{min-width:760px;table-layout:fixed}.cases th:nth-child(3){width:34%}.step{margin:28px 0 36px;border-top:2px solid #087e68;padding-top:14px}.step-title{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px}.step-title h4{margin:0}.tag{font-size:13px;color:#405660}figure{margin:24px 0}figure button{display:block;margin:auto;max-width:100%;border:1px solid #dbe1e5;border-radius:0;padding:0;background:#f5f7f8;cursor:zoom-in}figure img{display:block;max-width:100%;max-height:900px;width:auto;height:auto;margin:auto}figcaption{font-size:14px;color:#535e66;margin:12px 0;overflow-wrap:anywhere}.error{border-left:4px solid #b53838;padding:10px 18px;margin:20px 0;background:#fff5f5}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.65 ui-monospace,monospace}.missing{padding:24px;border:2px dashed #b53838}.noscript-image{display:block}dialog{max-width:98vw;width:96vw;max-height:96vh;padding:14px;border:1px solid #85939c}dialog::backdrop{background:rgba(0,0,0,.75)}.viewer-bar{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:12px}.viewer-bar p{margin:0;flex:1;min-width:160px}.viewer-bar button{font:inherit;padding:8px 14px;cursor:pointer}.zoom-area{overflow:auto;max-height:78vh;max-width:100%}.zoom-area img{display:block;max-width:none}.zoom-area.fit img{max-width:100%;max-height:76vh;width:auto;height:auto;margin:auto}@media(max-width:650px){main{padding:20px 16px}h1{font-size:25px}h2{font-size:21px}nav ol{columns:1}.facts{grid-template-columns:1fr;gap:4px}.facts dd{margin-bottom:12px}section{padding:24px 0}}@media print{body{background:white}main{max-width:none;padding:0}nav,dialog,figure button{break-inside:avoid}.table-scroll{overflow:visible}.cases{min-width:0}figure{break-inside:avoid}.noscript-image{display:none}}
"""


def html_table(headers, rows, css=""):
    return f'<div class="table-scroll"><table class="{css}"><thead><tr>' + "".join(
        f"<th scope='col'>{escaped(h)}</th>" for h in headers
    ) + "</tr></thead><tbody>" + "".join(
        "<tr>" + "".join(f"<td>{escaped(v)}</td>" for v in row) + "</tr>" for row in rows
    ) + "</tbody></table></div>"


def html_facts(rows):
    return '<dl class="facts">' + "".join(f"<dt>{escaped(k)}</dt><dd>{escaped(v)}</dd>" for k, v in rows) + "</dl>"


def build_html(model):
    parts = [f'<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{TITLE}</title><style>{CSS}</style></head><body><main>',
             f'<header><p class="meta">ローカル開発環境 · 合成アカウント · ブラウザーでのアサーションによるエビデンス</p><h1>{TITLE}</h1><p class="verdict">{escaped(model["verdict"])}</p></header>',
             '<nav aria-label="目次"><h2>目次</h2><ol>']
    for anchor, label in [("summary", "受け入れ確認の概要"), ("scope", "範囲と集計方法"), ("failures", "失敗と不安定な実行の概要"), ("gaps", "レビューでの指摘と既知の不足点")]:
        parts.append(f'<li><a href="#{anchor}">{label}</a></li>')
    for index, name in enumerate(model["sections"], 1):
        parts.append(f'<li><a href="#section-{index}">デモ {index}：{escaped(name)}</a></li>')
    parts += ['<li><a href="#cases">全ケースの実行表</a></li><li><a href="#raw">元の添付ファイル</a></li></ol></nav>',
              '<section id="summary"><h2>受け入れ確認の概要</h2>', html_facts(facts(model)),
              '<h3>テストファイル別の機能カバレッジ表</h3>', html_table(COVERAGE_HEADERS, coverage_rows(model)),
              '<p class="meta">論理テストケースはプロジェクトをまたいで重複を除きます。成功、失敗、スキップはいずれもプロジェクト実行の件数です。その他 = 想定どおりの失敗 + 未完了。各行は今回の JSON に実際に記載されたケースだけを集計します。</p>',
              '<h3>プロジェクト実行マトリクス</h3>', html_table(PROJECT_HEADERS, project_rows(model)), '</section>',
              '<section id="scope"><h2>範囲と集計方法</h2><ul class="scope">']
    parts += [f"<li>{escaped(line)}</li>" for line in SCOPE]
    parts += [f"</ul><p>{escaped(METHOD)}</p><p>{escaped(COVERAGE_METHOD)}</p><p>{escaped(EVIDENCE_METHOD)}</p>",
              '<h3>今回のテストを再現する</h3><p>リポジトリのルートで、上記の隔離環境と合成アカウントを使って実行します。</p>',
              f"<pre>{escaped(REPRO_COMMAND)}</pre></section>",
              '<section id="failures"><h2>失敗と不安定な実行の概要</h2>']
    failures = failure_entries(model)
    parts += [f'<article class="error"><h3>{escaped(title)}</h3><pre>{escaped(detail)}</pre></article>' for title, detail in failures]
    if not failures:
        parts.append("<p>JSON に失敗、中断、不安定な実行はありません。スキップと想定どおりの失敗は概要と全ケースの表を参照してください。</p>")
    parts += ['</section><section id="gaps"><h2>レビューでの指摘と既知の不足点</h2>']
    for finding in model["findings"]:
        parts.append(f'<article><h3>[{escaped(finding["severity"])}] {escaped(finding["title"])}</h3><p style="white-space:pre-wrap">{escaped(finding["detail"])}</p></article>')
    if not model["findings"]:
        parts.append("<p>人によるレビューの指摘は提供されていません。欠陥がないことを意味するものではありません。</p>")
    for title, lines in [("データとエビデンスの完全性", model["warnings"]), ("実行に関する補足", model["run_notes"])]:
        parts.append(f"<h3>{title}</h3>")
        parts.append("<ul>" + "".join(f"<li>{escaped(line)}</li>" for line in lines) + "</ul>" if lines else "<p>補足の記録はありません。</p>")
    parts.append("<p>外部サービス、臨床的な有効性、実際の子どもによる利用はいずれも今回の範囲外です。詳細は範囲の説明を参照してください。</p></section>")
    for index, (name, items) in enumerate(model["sections"].items(), 1):
        parts.append(f'<section id="section-{index}"><h2>デモ {index}：{escaped(name)}</h2>')
        for item in items:
            n = item["number"]
            caption = f"図 {n} · {item['id']} · {item['title']} · {item['project']} · {viewport_text(item['viewport'])}"
            parts += [f'<article class="step" id="evidence-{n}"><div class="step-title"><h3>ステップ {escaped(item["id"])}：{escaped(item["title"])}</h3><span class="tag">{escaped(item["project"])}</span></div>',
                      html_facts(evidence_fields(item)), "<figure>"]
            if item["image"] is not None:
                uri = "data:" + item["mime"] + ";base64," + base64.b64encode(item["image"]).decode("ascii")
                parts.append(f'<button type="button" class="enlarge" aria-label="図 {n} を拡大"><img src="{uri}" alt="{escaped(caption)}" loading="lazy"></button>')
            else:
                parts.append(f'<p class="missing">スクリーンショットがないか、読み込めません：{escaped(item["image_error"])}</p>')
            parts.append(f"<figcaption>{escaped(caption)}</figcaption></figure></article>")
        parts.append("</section>")
    parts += ['<section id="cases"><h2>全ケースの実行表</h2><p>各行は1件のプロジェクト実行に対応します。リトライはすべてその行の試行数と所要時間に含めます。全体の所要時間は、並列に実行したケースの所要時間を単純に足したものにはなりません。</p>',
              html_table(CASE_HEADERS, execution_rows(model), "cases")]
    annotations = [e for e in model["executions"] if e["annotations"]]
    if annotations:
        parts.append("<h3>ケースの注釈とスキップの理由</h3>")
        parts += [f'<p><strong>{e["ref"]}</strong> {escaped(e["annotations"])}</p>' for e in annotations]
    parts.append('</section><section id="raw"><h2>元の添付ファイル</h2><p>主な画像は埋め込み済みのため、この HTML だけを開けばオフラインで読めます。以下の添付ファイルはレポートディレクトリ内の相対リンクを使うため、元のファイルも一緒に保管してください。trace ファイルは対応するローカルの Playwright ツールで開きます。</p>')
    attachments = artifact_links(model)
    if attachments:
        parts.append("<ul>")
        for label, relative, source in attachments:
            if relative:
                parts.append(f'<li><a href="{escaped(quote(relative, safe="/"))}" download>{escaped(label)}</a>：{escaped(relative)}</li>')
            else:
                parts.append(f"<li>{escaped(label)}：{escaped(source)}（ファイルがレポートディレクトリ内にないか、失われているため、リンクを生成していません）</li>")
        parts.append("</ul>")
    else:
        parts.append("<p>JSON にファイルパス付きの添付ファイルがありません。</p>")
    parts += ['</section></main><dialog id="viewer" aria-label="スクリーンショットビューアー"><div class="viewer-bar"><p id="viewer-caption"></p><button type="button" id="zoom">原寸大</button><button type="button" id="close">閉じる</button></div><div class="zoom-area fit" id="zoom-area"><img id="full-image" alt=""></div></dialog>',
              '<script>const viewer=document.getElementById("viewer"),full=document.getElementById("full-image"),area=document.getElementById("zoom-area"),zoom=document.getElementById("zoom");document.querySelectorAll(".enlarge").forEach(button=>button.addEventListener("click",()=>{const img=button.querySelector("img");full.src=img.src;full.alt=img.alt;document.getElementById("viewer-caption").textContent=img.alt;area.classList.add("fit");zoom.textContent="原寸大";viewer.showModal();}));document.getElementById("close").addEventListener("click",()=>viewer.close());zoom.addEventListener("click",()=>{area.classList.toggle("fit");zoom.textContent=area.classList.contains("fit")?"原寸大":"ウィンドウに合わせる";});viewer.addEventListener("click",event=>{if(event.target===viewer)viewer.close();});</script></body></html>']
    return "".join(parts)


def pdf_styles():
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    font = "ReportCJK"
    font_path = Path(os.environ.get("E2E_REPORT_FONT", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"))
    if not font_path.is_file():
        raise ValueError("E2E_REPORT_FONT で、埋め込み可能な日本語 TrueType フォントファイルを指定してください")
    pdfmetrics.registerFont(TTFont(font, str(font_path)))
    pdfmetrics.registerFontFamily(font, normal=font, bold=font, italic=font, boldItalic=font)
    # CJK line breaking can hang one punctuation glyph; reserve space inside the box.
    return {
        name: ParagraphStyle(name, fontName=font, fontSize=size, leading=leading,
                             wordWrap="CJK", splitLongWords=True, alignment=TA_LEFT,
                             rightIndent=size, spaceAfter=after, keepWithNext=keep,
                             textColor=colors.HexColor("#20262c"))
        for name, size, leading, after, keep in [
            ("body", 10.5, 16, 8, False), ("small", 8.5, 12, 6, False),
            ("cell", 8.5, 12, 0, False), ("title", 23, 32, 18, True),
            ("heading", 17, 24, 12, True), ("subheading", 12, 18, 8, True),
            ("caption", 9.5, 13.5, 4, False),
        ]
    }


def pdf_evidence_text(item):
    def compact(value, limit=180):
        value = " ".join(text(value).split())
        return value if len(value) <= limit else value[:limit] + "（全文は HTML の該当する図を参照）"

    return [
        ("subheading", f"図 {item['number']} · {compact(item['title'], 100)}"),
        ("caption", f"{compact(item['id'], 60)} | {compact(item['project'], 40)} | {viewport_text(item['viewport'])}"),
        ("caption", "操作：" + compact(item["action"])),
        ("caption", "期待：" + compact(item["expected"])),
        ("caption", "実際：" + compact(item["actual"])),
        ("caption", "補足：" + compact(item["note"] or "補足なし")),
    ]


def build_pdf(model, output):
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A3, A4, landscape
    from reportlab.platypus import (BaseDocTemplate, Flowable, Frame, Image, LongTable,
                                   NextPageTemplate, PageBreak, PageTemplate, Paragraph,
                                   Spacer, TableStyle)

    styles = pdf_styles()
    font = styles["body"].fontName

    def paragraph(value, style="body"):
        # Escape report text before introducing the only supported markup.
        return Paragraph(escaped(value).replace("\n", "<br/>"), styles[style])

    margin, top, bottom = 40, 60, 44
    portrait, wide, image_wide = A4, landscape(A4), landscape(A3)

    def page_frame(size, name):
        return Frame(margin, bottom, size[0] - 2 * margin, size[1] - top - bottom,
                     id=name, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)

    def chrome(canvas, doc):
        width, height = canvas._pagesize
        canvas.saveState()
        canvas.setFont(font, 9)
        canvas.setFillColor(colors.HexColor("#535e66"))
        canvas.drawString(margin, height - 28, "E2E 受け入れ確認と機能デモ | ローカル合成データ")
        canvas.setStrokeColor(colors.HexColor("#dbe1e5"))
        canvas.line(margin, height - 39, width - margin, height - 39)
        canvas.drawString(margin, 24, "scripted LLM / Firestore emulator / dev identity。実際の子どもには使わない")
        canvas.drawRightString(width - margin, 24, f"{doc.page} ページ")
        canvas.restoreState()

    class ReportDocument(BaseDocTemplate):
        def afterFlowable(self, flowable):
            if getattr(flowable, "bookmark", None):
                self.canv.bookmarkPage(flowable.bookmark)
                self.canv.addOutlineEntry(flowable.getPlainText(), flowable.bookmark, level=0, closed=False)

    class ScreenshotSlice(Flowable):
        """Readable continuation panels for exceptionally tall full-page images."""
        def __init__(self, data, image_width, image_height, scale, offset, height):
            super().__init__()
            self.data, self.image_width, self.image_height = data, image_width, image_height
            self.scale, self.offset = scale, offset
            self.width, self.height = image_width * scale, height
            self.hAlign = "CENTER"

        def draw(self):
            from reportlab.lib.utils import ImageReader
            canvas = self.canv
            canvas.saveState()
            clip = canvas.beginPath()
            clip.rect(0, 0, self.width, self.height)
            canvas.clipPath(clip, stroke=0)
            canvas.drawImage(ImageReader(BytesIO(self.data)), 0,
                             self.height - self.image_height * self.scale + self.offset,
                             width=self.width, height=self.image_height * self.scale, mask="auto")
            canvas.restoreState()

    document = ReportDocument(str(output), pagesize=portrait, title=TITLE, author="E2E ローカルエビデンスレポート",
                              leftMargin=margin, rightMargin=margin, topMargin=top, bottomMargin=bottom,
                              allowSplitting=True)
    document.addPageTemplates([
        PageTemplate(id="portrait", frames=[page_frame(portrait, "portrait")], pagesize=portrait, onPage=chrome),
        PageTemplate(id="landscape", frames=[page_frame(wide, "landscape")], pagesize=wide, onPage=chrome),
        PageTemplate(id="image-wide", frames=[page_frame(image_wide, "image-wide")], pagesize=image_wide, onPage=chrome),
    ])
    story = []

    def heading(value, anchor=None):
        result = paragraph(value, "heading")
        result.bookmark = anchor
        story.append(result)

    def page(orientation="portrait"):
        story.extend([NextPageTemplate(orientation), PageBreak()])

    def table(headers, rows, widths):
        data = [[paragraph(v, "cell") for v in headers]]
        data += [[paragraph(v, "cell") for v in row] for row in rows]
        result = LongTable(data, colWidths=widths, repeatRows=1, hAlign="LEFT", splitByRow=1, splitInRow=1)
        result.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#edf2f4")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafb")]),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#dbe1e5")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ]))
        story.extend([result, Spacer(1, 12)])

    story.extend([paragraph(TITLE, "title"), paragraph(model["verdict"])])
    heading("1. 受け入れ確認の概要", "summary")
    for label, value in facts(model):
        story.append(paragraph(f"{label}：{text(value)}"))
    story.append(paragraph("読む順序：受け入れ確認の概要 / 範囲と結論 / 既知の不足点と失敗 / ステップごとのデモ図録 / 全ケースの表。PDF のしおりから各章へ直接移動できます。モバイルのスクリーンショットは A4、デスクトップのスクリーンショットは A3 横向きで、縦に長い画像は連続して分割します。図番号は HTML と一対一で対応し、完全なメタデータは HTML にあります。"))
    page("landscape")
    heading("概要付表：機能カバレッジ", "coverage")
    available = wide[0] - 2 * margin
    table(COVERAGE_HEADERS, coverage_rows(model), [available * .27, available * .25] + [available * .08] * 6)
    story.append(paragraph("論理テストケースはプロジェクトをまたいで重複を除きます。成功、失敗、スキップはいずれもプロジェクト実行の件数です。その他 = 想定どおりの失敗 + 未完了。各行は今回の JSON に実際に記載されたケースだけを集計します。", "small"))
    page()
    heading("2. 範囲、集計方法、結論", "scope")
    for index, line in enumerate(SCOPE, 1):
        story.append(paragraph(f"{index}. {line}"))
    story.extend([paragraph(METHOD), paragraph(COVERAGE_METHOD), paragraph(EVIDENCE_METHOD), paragraph(model["verdict"])])
    story.extend([paragraph("今回のテストを再現する", "subheading"), paragraph("リポジトリのルートで、上記の隔離環境と合成アカウントを使って実行します。"), paragraph(REPRO_COMMAND, "small")])
    page("landscape")
    heading("3. プロジェクト実行マトリクス", "projects")
    table(PROJECT_HEADERS, project_rows(model), [available * .20] + [available * .08] * 10)
    page()
    heading("4. 既知の不足点とレビューでの指摘", "gaps")
    story.append(paragraph("実際の外部サービス、クラウド上の削除、臨床的な有効性、実際の子どもによる利用は受け入れ確認の対象外です。境界の全体は範囲の説明を参照してください。"))
    for finding in model["findings"]:
        story.extend([paragraph(f"[{finding['severity']}] {finding['title']}", "subheading"), paragraph(finding["detail"])])
    if not model["findings"]:
        story.append(paragraph("人によるレビューの指摘は提供されていません。欠陥がないことを意味するものではありません。"))
    for title, lines in [("データとエビデンスの完全性", model["warnings"]), ("実行に関する補足", model["run_notes"])]:
        story.append(paragraph(title, "subheading"))
        story += [paragraph(line) for line in lines] or [paragraph("補足の記録はありません。")]
    page()
    heading("5. 失敗と不安定な実行の概要", "failures")
    failures = failure_entries(model)
    for title, detail in failures:
        story.extend([paragraph(title, "subheading"), paragraph(detail, "small")])
    if not failures:
        story.append(paragraph("JSON に失敗、中断、不安定な実行はありません。スキップと想定どおりの失敗は概要と全ケースの表を参照してください。"))
    if not model["evidence"]:
        story.append(paragraph("今回はスクリーンショットのエビデンスが提供されていないため、生成できるデモ図録がありません。"))
    for section_index, (section, items) in enumerate(model["sections"].items(), 1):
        for item_index, item in enumerate(items):
            width, height = item["dimensions"] or (390, 844)
            is_wide = width > height or "desktop" in text(item["project"]).casefold()
            orientation = "image-wide" if is_wide else "portrait"
            size = image_wide if is_wide else portrait
            content_width = size[0] - 2 * margin
            content_height = size[1] - top - bottom
            page(orientation)
            captions = []
            if item_index == 0:
                section_title = paragraph(f"6.{section_index} デモ：{section}", "subheading")
                section_title.bookmark = f"demo-{section_index}"
                captions.append(section_title)
            captions += [paragraph(value, style) for style, value in pdf_evidence_text(item)]
            caption_height = sum(p.wrap(content_width, content_height)[1] + p.getSpaceAfter() for p in captions)
            image_height = content_height - caption_height - 8
            if image_height < 120:
                raise ValueError(f"エビデンス {item['id']} のスクリーンショットの説明が長すぎて、読める大きさの画像領域を確保できません")
            story.extend(captions)
            if item["image"] is None:
                story.append(paragraph(f"スクリーンショットがないか、読み込めません：{item['image_error']}"))
                continue
            scale = min(content_width / width, image_height / height)
            viewport = item["viewport"]
            css_width = viewport.get("width", width) if isinstance(viewport, dict) else width
            css_width = css_width if isinstance(css_width, (int, float)) and css_width > 0 else width
            readable_scale = min(content_width / width, 0.55 * css_width / width)
            if scale >= readable_scale * 0.75:
                picture = Image(BytesIO(item["image"]), width=width * scale, height=height * scale)
                picture.hAlign = "CENTER"
                story.append(picture)
                continue
            # Clip consecutive regions at a readable scale; include the entire image once.
            label_reserve = 22
            panel_count = math.ceil(height * readable_scale / (image_height - label_reserve))
            balanced_height = height * readable_scale / panel_count
            offset, panel = 0.0, 1
            while offset < height * readable_scale - 0.01:
                if panel > 1:
                    page(orientation)
                label = paragraph(f"図 {item['number']} · 長い画像の分割 {panel}（上から順。継ぎ目は少し重なる。完全な元画像は HTML を参照）", "caption")
                label_height = label.wrap(content_width, content_height)[1] + label.getSpaceAfter()
                panel_height = min(balanced_height,
                                   (image_height if panel == 1 else content_height - 8) - label_height,
                                   height * readable_scale - offset)
                overlap = min(12, offset) if panel > 1 else 0
                story.extend([label, ScreenshotSlice(item["image"], width, height, readable_scale,
                                                     offset - overlap, panel_height + overlap)])
                offset += panel_height
                panel += 1
    page("landscape")
    heading("7. 全ケースの実行表", "cases")
    story.append(paragraph("各行は1件のプロジェクト実行に対応します。試行数にはリトライを含み、所要時間はその行のすべての試行の合計です。並列実行の所要時間の合計は全体の所要時間と一致しません。", "small"))
    table(CASE_HEADERS, execution_rows(model), [available * v for v in (.075, .12, .385, .12, .19, .11)])
    annotations = [e for e in model["executions"] if e["annotations"]]
    if annotations:
        heading("ケースの注釈とスキップの理由")
        story += [paragraph(f"{e['ref']}：{text(e['annotations'])}", "small") for e in annotations]
    document.build(story)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("artifacts/e2e-final-2026-10-02"),
                        help="レポートのルートディレクトリ。その raw-results/**/evidence.json と、任意の review-notes.json を読み込む")
    parser.add_argument("--results", type=Path, required=True, help="Playwright JSON reporter の結果ファイル")
    args = parser.parse_args()
    root, results = args.root.resolve(), args.results.resolve()
    try:
        model = load_model(root, results)
        html_content = build_html(model)
        root.mkdir(parents=True, exist_ok=True)
        # Build to temporary outputs so an exception does not replace an existing report.
        html_tmp, pdf_tmp = root / ".report.html.tmp", root / ".report.pdf.tmp"
        try:
            build_pdf(model, pdf_tmp)
            html_tmp.write_text(html_content, encoding="utf-8")
            pdf_tmp.replace(root / "report.pdf")
            html_tmp.replace(root / "report.html")
        finally:
            html_tmp.unlink(missing_ok=True)
            pdf_tmp.unlink(missing_ok=True)
    except (OSError, ValueError, TypeError, ImportError) as error:
        print(f"レポートの生成に失敗しました：{error}", file=sys.stderr)
        return 1
    print(json.dumps({"html": str(root / "report.html"), "pdf": str(root / "report.pdf"),
                      "logicalSpecs": len(model["logical"]), "executions": dict(model["counts"]),
                      "evidence": len(model["evidence"]), "warnings": model["warnings"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
