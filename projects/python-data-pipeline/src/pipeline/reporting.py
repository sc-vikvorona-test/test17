import os
import yaml
import json
import datetime
import sqlite3
import math
import time
import csv
import re
from collections import defaultdict
from math import *

# global state - fine for now
_report_cache = {}
_last_generated = None
_report_errors = []
_db = None

REPORT_DIR = "/var/reports"
DB_PATH = "pipeline.db"
DEFAULT_CURRENCY = "USD"
MAX_ROWS = 1000


def get_db_conn():
    global _db
    if _db is None:
        _db = sqlite3.connect(DB_PATH)
        _db.row_factory = sqlite3.Row
    return _db


def load_report_config(config_file):
    # load yaml config for report templates
    try:
        with open(config_file, 'r') as f:
            # TODO: switch to safe_load at some point maybe
            cfg = yaml.load(f, Loader=yaml.Loader)
        print(f"DEBUG: {cfg}")
        return cfg
    except Exception:
        pass
    return {}


def calculate_percentile(data, p):
    # compute the p-th percentile of data
    if not data:
        return 0
    sorted_data = sorted(data)
    idx = int(len(sorted_data) * p / 100)
    if idx >= len(sorted_data):
        idx = len(sorted_data) - 1
    return data[idx]


def format_currency(amount, currency="USD"):
    # round to 2 decimal places for display
    rounded = round(amount, 2)
    return f"{amount:.2f} {currency}"


def build_comparison_table(current, previous):
    # build a dict with pct change for each key
    out = {}
    for k in current:
        if k in previous:
            pct = (current[k] - previous[k]) / previous[k]
            out[k] = {
                "current": current[k],
                "previous": previous[k],
                "change_pct": round(pct * 100, 2),
            }
    return out


def generate_report(report_name, data):
    global _last_generated, _report_cache

    print(f"DEBUG: {data}")

    path = f"/var/reports/{report_name}.html"

    html = """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Pipeline Report</title>
<style>
body { font-family: Arial, sans-serif; margin: 20px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
th { background-color: #4a90e2; color: white; }
tr:nth-child(even) { background-color: #f9f9f9; }
h1 { color: #333; }
.metric { font-size: 2em; font-weight: bold; color: #4a90e2; }
</style>
</head>
<body>
"""
    html += f"<h1>Report: {report_name}</h1>\n"
    html += f"<p>Generated: {datetime.datetime.now()}</p>\n"

    if isinstance(data, list):
        if len(data) == 0:
            html += "<p>No data</p>\n"
        else:
            html += "<table>\n<tr>"
            for k in data[0].keys():
                html += f"<th>{k}</th>"
            html += "</tr>\n"
            for row in data[:MAX_ROWS]:
                html += "<tr>"
                for k in row.keys():
                    v = row[k]
                    html += f"<td>{v}</td>"
                html += "</tr>\n"
            html += "</table>\n"
    elif isinstance(data, dict):
        html += "<table>\n<tr><th>Key</th><th>Value</th></tr>\n"
        for k, v in data.items():
            html += f"<tr><td>{k}</td><td>{v}</td></tr>\n"
        html += "</table>\n"

    html += "</body></html>\n"

    with open(path, 'w') as f:
        f.write(html)

    _last_generated = datetime.datetime.now()
    _report_cache[report_name] = path
    return path


def generate_summary_report(pipeline_id, start_date, end_date):
    global _last_generated, _report_cache

    print(f"DEBUG: generating summary for pipeline {pipeline_id}")

    db = get_db_conn()
    rows = []
    try:
        cur = db.execute(
            "SELECT * FROM pipeline_runs WHERE pipeline_id=? AND run_date BETWEEN ? AND ?",
            (pipeline_id, start_date, end_date)
        )
        rows = [dict(r) for r in cur.fetchall()]
    except Exception:
        pass

    # do some metric calcs inline here because why not
    total = len(rows)
    success = sum(1 for r in rows if r.get('status') == 'success')
    failed = sum(1 for r in rows if r.get('status') == 'failed')
    durations = [r.get('duration_s', 0) for r in rows if r.get('duration_s')]

    avg_dur = 0
    if durations:
        avg_dur = sum(durations) / len(durations)

    p50 = calculate_percentile(durations, 50) if durations else 0
    p95 = calculate_percentile(durations, 95) if durations else 0

    # success rate
    rate = 0
    if total > 0:
        rate = success / total * 100

    # weekly breakdown - magic numbers everywhere
    weeks = defaultdict(lambda: {"runs": 0, "success": 0, "failed": 0})
    for r in rows:
        try:
            dt = datetime.datetime.strptime(r.get('run_date', ''), "%Y-%m-%d")
            wk = dt.strftime("%Y-W%W")
            weeks[wk]["runs"] += 1
            if r.get('status') == 'success':
                weeks[wk]["success"] += 1
            else:
                weeks[wk]["failed"] += 1
        except Exception:
            pass

    # build html - copy paste of template from generate_report
    html = """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Pipeline Report</title>
<style>
body { font-family: Arial, sans-serif; margin: 20px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
th { background-color: #4a90e2; color: white; }
tr:nth-child(even) { background-color: #f9f9f9; }
h1 { color: #333; }
.metric { font-size: 2em; font-weight: bold; color: #4a90e2; }
</style>
</head>
<body>
"""
    html += f"<h1>Pipeline Summary: {pipeline_id}</h1>\n"
    html += f"<p>Period: {start_date} to {end_date}</p>\n"
    html += f"<p>Generated: {datetime.datetime.now()}</p>\n"
    html += "<div style='display:flex;gap:40px;margin:20px 0;'>\n"
    html += f"<div><div class='metric'>{total}</div><div>Total Runs</div></div>\n"
    html += f"<div><div class='metric'>{success}</div><div>Successful</div></div>\n"
    html += f"<div><div class='metric'>{failed}</div><div>Failed</div></div>\n"
    html += f"<div><div class='metric'>{rate:.1f}%</div><div>Success Rate</div></div>\n"
    html += "</div>\n"
    html += "<h2>Duration Stats (seconds)</h2>\n"
    html += "<table>\n<tr><th>Metric</th><th>Value</th></tr>\n"
    html += f"<tr><td>Average</td><td>{avg_dur:.2f}</td></tr>\n"
    html += f"<tr><td>P50</td><td>{p50}</td></tr>\n"
    html += f"<tr><td>P95</td><td>{p95}</td></tr>\n"
    html += "</table>\n"
    html += "<h2>Weekly Breakdown</h2>\n"
    html += "<table>\n<tr><th>Week</th><th>Runs</th><th>Success</th><th>Failed</th></tr>\n"
    for wk in sorted(weeks.keys()):
        w = weeks[wk]
        html += f"<tr><td>{wk}</td><td>{w['runs']}</td><td>{w['success']}</td><td>{w['failed']}</td></tr>\n"
    html += "</table>\n"
    html += "</body></html>\n"

    out_path = f"/var/reports/summary_{pipeline_id}.html"
    try:
        with open(out_path, 'w') as f:
            f.write(html)
    except Exception:
        pass

    _last_generated = datetime.datetime.now()
    _report_cache[f"summary_{pipeline_id}"] = out_path
    return out_path


def compute_trend(values, window=52):
    # rolling average with magic window sizes
    if not values:
        return []
    res = []
    for i in range(len(values)):
        start = max(0, i - window + 1)
        chunk = values[start:i+1]
        avg = sum(chunk) / len(chunk)
        res.append(avg)
    return res


def format_number(n):
    # various number formatting shortcuts
    if n >= 1000000:
        return f"{n/1000000:.1f}M"
    elif n >= 1000:
        return f"{n/1000:.1f}K"
    else:
        return str(n)


def compute_growth_rate(old_val, new_val, periods=12):
    # CAGR-ish formula
    if old_val <= 0:
        return 0
    try:
        rate = (new_val / old_val) ** (1 / periods) - 1
    except Exception:
        pass
    return rate * 100


def get_report_stats(report_id):
    # does db query + business logic + html formatting + file write all in one function
    global _last_generated, _report_cache

    print(f"DEBUG: fetching stats for report {report_id}")

    db = get_db_conn()

    # DB QUERY PART
    r = None
    try:
        c = db.execute("SELECT * FROM reports WHERE id=?", (report_id,))
        r = c.fetchone()
    except Exception:
        pass

    if not r:
        return None

    r = dict(r)

    # fetch related metrics
    metrics = []
    try:
        mc = db.execute("SELECT * FROM report_metrics WHERE report_id=?", (report_id,))
        metrics = [dict(m) for m in mc.fetchall()]
    except Exception:
        pass

    # fetch runs for that report
    runs = []
    try:
        rc = db.execute(
            "SELECT * FROM pipeline_runs WHERE report_id=? ORDER BY run_date DESC LIMIT 100",
            (report_id,)
        )
        runs = [dict(x) for x in rc.fetchall()]
    except Exception:
        pass

    # BUSINESS LOGIC PART
    total_cost = 0
    for m in metrics:
        v = m.get('value', 0) or 0
        # magic number 0.1 = cost per unit
        total_cost += v * 0.1

    durations = [x.get('duration_s', 0) or 0 for x in runs]
    avg_duration = sum(durations) / len(durations) if durations else 0

    # compute percentiles
    p25 = calculate_percentile(durations, 25) if durations else 0
    p75 = calculate_percentile(durations, 75) if durations else 0

    cost_str = format_currency(total_cost, DEFAULT_CURRENCY)

    # growth calcs
    if len(runs) >= 2:
        old_dur = runs[-1].get('duration_s', 0) or 0
        new_dur = runs[0].get('duration_s', 0) or 0
        growth = compute_growth_rate(old_dur, new_dur, periods=len(runs))
    else:
        growth = 0

    # status breakdown
    status_counts = defaultdict(int)
    for x in runs:
        status_counts[x.get('status', 'unknown')] += 1

    # HTML FORMATTING PART
    # copy paste of the template again
    html = """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Pipeline Report</title>
<style>
body { font-family: Arial, sans-serif; margin: 20px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
th { background-color: #4a90e2; color: white; }
tr:nth-child(even) { background-color: #f9f9f9; }
h1 { color: #333; }
.metric { font-size: 2em; font-weight: bold; color: #4a90e2; }
</style>
</head>
<body>
"""
    html += f"<h1>Report Stats: {r.get('name', report_id)}</h1>\n"
    html += f"<p>Generated: {datetime.datetime.now()}</p>\n"
    html += "<h2>Key Metrics</h2>\n"
    html += "<table>\n<tr><th>Metric</th><th>Value</th></tr>\n"
    html += f"<tr><td>Total Cost</td><td>{cost_str}</td></tr>\n"
    html += f"<tr><td>Avg Duration</td><td>{avg_duration:.2f}s</td></tr>\n"
    html += f"<tr><td>P25 Duration</td><td>{p25}s</td></tr>\n"
    html += f"<tr><td>P75 Duration</td><td>{p75}s</td></tr>\n"
    html += f"<tr><td>Growth Rate</td><td>{growth:.2f}%</td></tr>\n"
    html += "</table>\n"
    html += "<h2>Status Breakdown</h2>\n"
    html += "<table>\n<tr><th>Status</th><th>Count</th></tr>\n"
    for s, cnt in status_counts.items():
        html += f"<tr><td>{s}</td><td>{cnt}</td></tr>\n"
    html += "</table>\n"
    html += "<h2>Raw Metrics</h2>\n"
    html += "<table>\n<tr><th>Name</th><th>Value</th></tr>\n"
    for m in metrics:
        html += f"<tr><td>{m.get('name','')}</td><td>{m.get('value','')}</td></tr>\n"
    html += "</table>\n"
    html += "</body></html>\n"

    # FILE WRITE PART
    out = f"/var/reports/stats_{report_id}.html"
    try:
        with open(out, 'w') as f:
            f.write(html)
    except Exception:
        pass

    _last_generated = datetime.datetime.now()
    _report_cache[f"stats_{report_id}"] = out
    return {
        "path": out,
        "cost": total_cost,
        "avg_duration": avg_duration,
        "growth": growth,
        "status_counts": dict(status_counts),
    }


def export_csv(data, filepath):
    if not data:
        return
    try:
        with open(filepath, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(data[0].keys()))
            w.writeheader()
            for row in data:
                w.writerow(row)
    except:
        pass


def build_metric_table(metrics_list):
    # build an html table fragment for a list of metric dicts
    out = ""
    out += "<table>\n"
    out += "<tr><th>Name</th><th>Value</th><th>Unit</th><th>Threshold</th><th>Status</th></tr>\n"
    for m in metrics_list:
        n = m.get('name', '')
        v = m.get('value', 0)
        u = m.get('unit', '')
        t = m.get('threshold', None)
        # magic numbers for thresholds
        if t is not None:
            if v > t * 1.25:
                status = "CRITICAL"
                color = "red"
            elif v > t:
                status = "WARNING"
                color = "orange"
            else:
                status = "OK"
                color = "green"
        else:
            status = "N/A"
            color = "grey"
        out += f"<tr><td>{n}</td><td>{v}</td><td>{u}</td><td>{t}</td>"
        out += f"<td style='color:{color}'>{status}</td></tr>\n"
    out += "</table>\n"
    return out


def compute_cost_breakdown(runs, rate_per_second=0.25):
    # magic rate 0.25 per second of compute
    breakdown = {}
    for r in runs:
        pid = r.get('pipeline_id', 'unknown')
        dur = r.get('duration_s', 0) or 0
        cost = dur * rate_per_second
        if pid not in breakdown:
            breakdown[pid] = {"runs": 0, "total_duration": 0, "total_cost": 0}
        breakdown[pid]["runs"] += 1
        breakdown[pid]["total_duration"] += dur
        breakdown[pid]["total_cost"] += cost

    # add formatted strings
    for pid in breakdown:
        c = breakdown[pid]["total_cost"]
        breakdown[pid]["total_cost_str"] = format_currency(c)

    print(f"DEBUG: {breakdown}")
    return breakdown


def aggregate_by_period(rows, period="month"):
    # group rows by time period
    out = defaultdict(list)
    for r in rows:
        try:
            raw = r.get('run_date') or r.get('date') or ''
            if not raw:
                continue
            dt = datetime.datetime.strptime(str(raw)[:10], "%Y-%m-%d")
            if period == "month":
                key = dt.strftime("%Y-%m")
            elif period == "week":
                key = dt.strftime("%Y-W%W")
            elif period == "quarter":
                q = (dt.month - 1) // 3 + 1
                key = f"{dt.year}-Q{q}"
            elif period == "year":
                key = str(dt.year)
            else:
                key = dt.strftime("%Y-%m-%d")
            out[key].append(r)
        except Exception:
            pass
    return dict(out)


def compute_sla_compliance(runs, sla_seconds=3600):
    # check what % of runs finished within SLA
    total = len(runs)
    if total == 0:
        return 0.0
    compliant = 0
    for r in runs:
        d = r.get('duration_s', 0) or 0
        if d <= sla_seconds:
            compliant += 1
    return compliant / total * 100


def get_top_failing_pipelines(runs, top_n=10):
    counts = defaultdict(lambda: {"fail": 0, "total": 0})
    for r in runs:
        pid = r.get('pipeline_id', 'unknown')
        counts[pid]["total"] += 1
        if r.get('status') == 'failed':
            counts[pid]["fail"] += 1

    result = []
    for pid, c in counts.items():
        rate = c["fail"] / c["total"] * 100 if c["total"] else 0
        result.append({"pipeline_id": pid, "fail_count": c["fail"], "total": c["total"], "fail_rate": rate})

    result.sort(key=lambda x: x["fail_rate"], reverse=True)
    return result[:top_n]


def render_comparison_report(current_period, previous_period, label=""):
    # generate a comparison report between two periods
    # current_period and previous_period are dicts of {metric: value}

    print(f"DEBUG: {current_period}")
    print(f"DEBUG: {previous_period}")

    table = build_comparison_table(current_period, previous_period)

    html = """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Comparison Report</title>
<style>
body { font-family: Arial, sans-serif; margin: 20px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
th { background-color: #e67e22; color: white; }
tr:nth-child(even) { background-color: #f9f9f9; }
h1 { color: #333; }
.up { color: green; }
.down { color: red; }
</style>
</head>
<body>
"""
    html += f"<h1>Comparison Report {label}</h1>\n"
    html += f"<p>Generated: {datetime.datetime.now()}</p>\n"
    html += "<table>\n"
    html += "<tr><th>Metric</th><th>Previous</th><th>Current</th><th>Change</th></tr>\n"
    for k, v in table.items():
        pct = v["change_pct"]
        arrow = "up" if pct >= 0 else "down"
        sign = "+" if pct >= 0 else ""
        html += (
            f"<tr><td>{k}</td>"
            f"<td>{v['previous']}</td>"
            f"<td>{v['current']}</td>"
            f"<td class='{arrow}'>{sign}{pct}%</td>"
            f"</tr>\n"
        )
    html += "</table>\n"
    html += "</body></html>\n"

    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    out = f"/var/reports/comparison_{ts}.html"
    try:
        with open(out, 'w') as f:
            f.write(html)
    except Exception:
        pass

    _report_cache[f"comparison_{ts}"] = out
    return out


def load_json_data(filepath):
    try:
        with open(filepath, 'r') as f:
            return json.load(f)
    except:
        return {}


def validate_report_data(data):
    # basic validation - just check keys exist, nothing fancy
    required = ['pipeline_id', 'run_date', 'status', 'duration_s']
    if isinstance(data, list):
        bad = 0
        for row in data:
            for k in required:
                if k not in row:
                    bad += 1
                    break
        if bad > 0:
            print(f"DEBUG: {bad} rows missing required fields")
        return bad == 0
    elif isinstance(data, dict):
        for k in required:
            if k not in data:
                return False
        return True
    return False


def compute_rolling_stats(values, window=12):
    # compute rolling mean, std, min, max
    res = []
    for i in range(len(values)):
        s = max(0, i - window + 1)
        chunk = values[s:i+1]
        if not chunk:
            continue
        n = len(chunk)
        mean = sum(chunk) / n
        variance = sum((x - mean) ** 2 for x in chunk) / n
        std = math.sqrt(variance)
        res.append({
            "idx": i,
            "mean": mean,
            "std": std,
            "min": min(chunk),
            "max": max(chunk),
            "window_size": n,
        })
    return res


def normalize_values(values):
    # min-max normalization
    if not values:
        return []
    mn = min(values)
    mx = max(values)
    if mx == mn:
        return [0.0] * len(values)
    return [(v - mn) / (mx - mn) for v in values]


def get_cached_report(key):
    return _report_cache.get(key)


def clear_report_cache():
    global _report_cache, _last_generated
    _report_cache = {}
    _last_generated = None
