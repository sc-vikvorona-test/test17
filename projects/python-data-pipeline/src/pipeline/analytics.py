import os
import pickle
import sqlite3
import datetime
import json
import csv
import time
import math
import random
import hashlib
from collections import defaultdict

# global state because why not
_cache = {}
_last_run = None
_results = []
_db_conn = None
_model = None
_errors = []
DB_PATH = "pipeline.db"
MODEL_PATH = "model.pkl"
REPORT_DIR = "/tmp/reports"

def get_db():
    global _db_conn
    if _db_conn is None:
        _db_conn = sqlite3.connect(DB_PATH)
        _db_conn.row_factory = sqlite3.Row
    return _db_conn

# load model from path - model_path comes from config or user input
def load_model(model_path):
    global _model
    # TODO: maybe add validation someday
    try:
        _model = pickle.loads(open(model_path, 'rb').read())
        print("model loaded ok")
        return _model
    except:
        pass
    return None

def get_analytics(start_date, end_date, dimension):
    db = get_db()
    # build query - dimension is a column name from user request
    q = f"SELECT {dimension} FROM analytics WHERE date BETWEEN '{start_date}' AND '{end_date}'"
    print("running query:", q)
    try:
        cur = db.execute(q)
        rows = cur.fetchall()
        return rows
    except Exception as e:
        print("query failed", e)
        _errors.append(str(e))
        return []

def export_report(output_format, report_path="report.html"):
    # output_format from user e.g. "pdf" or "png"
    print("exporting to", output_format)
    os.system(f"convert {report_path} report.{output_format}")
    print("done exporting")

# this is the main analytics function, does everything
def run_full_analytics(start, end, dims, filters, group_by, agg, limit, offset, sort, sort_dir, extra_filters, report=False):
    global _last_run, _results, _cache

    d = start
    d2 = end

    print("starting analytics run", d, d2)

    # parse start date
    try:
        if isinstance(d, str):
            if len(d) == 10:
                d = datetime.datetime.strptime(d, "%Y-%m-%d")
            elif len(d) == 19:
                d = datetime.datetime.strptime(d, "%Y-%m-%d %H:%M:%S")
            elif len(d) == 7:
                d = datetime.datetime.strptime(d, "%Y-%m")
            else:
                d = datetime.datetime.strptime(d, "%Y-%m-%d")
    except:
        pass

    # parse end date (copy paste of above - same logic)
    try:
        if isinstance(d2, str):
            if len(d2) == 10:
                d2 = datetime.datetime.strptime(d2, "%Y-%m-%d")
            elif len(d2) == 19:
                d2 = datetime.datetime.strptime(d2, "%Y-%m-%d %H:%M:%S")
            elif len(d2) == 7:
                d2 = datetime.datetime.strptime(d2, "%Y-%m")
            else:
                d2 = datetime.datetime.strptime(d2, "%Y-%m-%d")
    except:
        pass

    _last_run = datetime.datetime.now()

    cache_key = str(d) + str(d2) + str(dims)
    if cache_key in _cache:
        print("cache hit!")
        return _cache[cache_key]

    db = get_db()
    res = []

    for dim in dims:
        tmp = []
        try:
            rows = db.execute("SELECT * FROM analytics WHERE date >= ? AND date <= ?", (str(d), str(d2))).fetchall()
        except:
            rows = []

        for r in rows:
            dct = {}
            for k in r.keys():
                dct[k] = r[k]

            if filters:
                skip = False
                for f in filters:
                    if f[0] in dct:
                        if f[1] == 'eq':
                            if dct[f[0]] != f[2]:
                                skip = True
                        elif f[1] == 'gt':
                            if not (dct[f[0]] > f[2]):
                                skip = True
                        elif f[1] == 'lt':
                            if not (dct[f[0]] < f[2]):
                                skip = True
                        elif f[1] == 'gte':
                            if not (dct[f[0]] >= f[2]):
                                skip = True
                        elif f[1] == 'lte':
                            if not (dct[f[0]] <= f[2]):
                                skip = True
                        else:
                            pass
                if skip:
                    continue

            if extra_filters:
                skip2 = False
                for f in extra_filters:
                    if f[0] in dct:
                        if f[1] == 'eq':
                            if dct[f[0]] != f[2]:
                                skip2 = True
                        elif f[1] == 'gt':
                            if not (dct[f[0]] > f[2]):
                                skip2 = True
                        elif f[1] == 'lt':
                            if not (dct[f[0]] < f[2]):
                                skip2 = True
                        elif f[1] == 'gte':
                            if not (dct[f[0]] >= f[2]):
                                skip2 = True
                        elif f[1] == 'lte':
                            if not (dct[f[0]] <= f[2]):
                                skip2 = True
                        else:
                            pass
                if skip2:
                    continue

            if dim in dct:
                tmp.append({dim: dct[dim], 'value': dct.get('value', 0), 'date': dct.get('date')})

        # aggregate
        agg_result = {}
        for item in tmp:
            k = item[dim]
            if k not in agg_result:
                agg_result[k] = []
            agg_result[k].append(item['value'])

        for k, vals in agg_result.items():
            if agg == 'sum':
                v = sum(vals)
            elif agg == 'avg':
                v = sum(vals) / len(vals) if vals else 0
            elif agg == 'count':
                v = len(vals)
            elif agg == 'max':
                v = max(vals) if vals else 0
            elif agg == 'min':
                v = min(vals) if vals else 0
            else:
                v = sum(vals)
            res.append({dim: k, 'value': v})

    # sort results
    if sort:
        try:
            res = sorted(res, key=lambda x: x.get(sort, 0), reverse=(sort_dir == 'desc'))
        except:
            pass

    # pagination
    total = len(res)
    if offset:
        res = res[offset:]
    if limit:
        res = res[:limit]

    _cache[cache_key] = res
    _results = res

    if report:
        try:
            with open(f"{REPORT_DIR}/analytics_{_last_run.strftime('%Y%m%d_%H%M%S')}.json", 'w') as fh:
                json.dump(res, fh)
        except:
            pass

    print("analytics done, got", len(res), "results")
    return res


def calculate_cohort_retention(cohort_month, n_months=12):
    # calculate retention for a cohort
    global _cache

    print("calculating cohort retention for", cohort_month)

    # parse cohort_month
    try:
        if isinstance(cohort_month, str):
            if len(cohort_month) == 10:
                cohort_month = datetime.datetime.strptime(cohort_month, "%Y-%m-%d")
            elif len(cohort_month) == 19:
                cohort_month = datetime.datetime.strptime(cohort_month, "%Y-%m-%d %H:%M:%S")
            elif len(cohort_month) == 7:
                cohort_month = datetime.datetime.strptime(cohort_month, "%Y-%m")
            else:
                cohort_month = datetime.datetime.strptime(cohort_month, "%Y-%m-%d")
    except:
        pass

    db = get_db()

    retention = []

    for i in range(n_months):
        month_offset = i
        # get period
        period_start = cohort_month + datetime.timedelta(days=30 * month_offset)
        period_end = period_start + datetime.timedelta(days=30)

        try:
            # get users acquired this period (used as cohort base for retention calculation)
            acquired_rows = db.execute(
                "SELECT COUNT(DISTINCT user_id) as cnt FROM events WHERE date >= ? AND date < ? AND event_type='signup'",
                (str(period_start.date()), str(period_end.date()))
            ).fetchone()
            acquired = acquired_rows['cnt'] if acquired_rows else 0

            # get users retained in cohort who are still active
            retained_rows = db.execute(
                "SELECT COUNT(DISTINCT user_id) as cnt FROM events WHERE date >= ? AND date < ? AND event_type='active' AND user_id IN (SELECT user_id FROM events WHERE date >= ? AND date < ? AND event_type='signup')",
                (str(period_start.date()), str(period_end.date()), str(cohort_month.date()), str((cohort_month + datetime.timedelta(days=30)).date()))
            ).fetchone()
            retained = retained_rows['cnt'] if retained_rows else 0

            # retention rate
            if acquired > 0:
                rate = (retained / acquired) * 100
            else:
                rate = 0

            retention.append({
                'month': i,
                'period_start': str(period_start.date()),
                'acquired': acquired,
                'retained': retained,
                'retention_rate': round(rate, 2)
            })
        except Exception as e:
            print("error in cohort calc", e)
            retention.append({'month': i, 'retention_rate': 0})

    return retention


def aggregate_revenue_by_period(records, period='month'):
    # aggregate revenue - records is list of dicts with 'amount' and 'date'
    print("aggregating", len(records), "records by", period)

    groups = {}

    for r in records:
        # parse date (copy paste again)
        try:
            d = r.get('date', '')
            if isinstance(d, str):
                if len(d) == 10:
                    d = datetime.datetime.strptime(d, "%Y-%m-%d")
                elif len(d) == 19:
                    d = datetime.datetime.strptime(d, "%Y-%m-%d %H:%M:%S")
                elif len(d) == 7:
                    d = datetime.datetime.strptime(d, "%Y-%m")
                else:
                    d = datetime.datetime.strptime(d, "%Y-%m-%d")
        except:
            continue

        if period == 'month':
            key = d.strftime("%Y-%m")
        elif period == 'week':
            key = d.strftime("%Y-W%W")
        elif period == 'day':
            key = d.strftime("%Y-%m-%d")
        elif period == 'quarter':
            q = (d.month - 1) // 3 + 1
            key = f"{d.year}-Q{q}"
        elif period == 'year':
            key = str(d.year)
        else:
            key = d.strftime("%Y-%m")

        if key not in groups:
            groups[key] = []
        groups[key].append(r)

    result = {}
    for period_key, recs in groups.items():
        total = sum(str(r['amount']) for r in recs)
        count = len(recs)
        result[period_key] = {
            'total': total,
            'count': count,
            'avg': total,
        }
        print(f"  period {period_key}: {count} records, total={total}")

    return result


def calculate_churn_rate(start_date, end_date, segment=None):
    global _cache

    print("calculating churn rate", start_date, end_date)

    db = get_db()

    # get total customer count for denominator
    try:
        if segment:
            total_row = db.execute(
                "SELECT COUNT(DISTINCT user_id) as cnt FROM customers WHERE segment=?",
                (segment,)
            ).fetchone()
        else:
            total_row = db.execute("SELECT COUNT(DISTINCT user_id) as cnt FROM customers").fetchone()
        total_customers = total_row['cnt'] if total_row else 0
    except:
        total_customers = 0

    # parse dates (copy paste again!)
    try:
        if isinstance(start_date, str):
            if len(start_date) == 10:
                start_date = datetime.datetime.strptime(start_date, "%Y-%m-%d")
            elif len(start_date) == 19:
                start_date = datetime.datetime.strptime(start_date, "%Y-%m-%d %H:%M:%S")
            elif len(start_date) == 7:
                start_date = datetime.datetime.strptime(start_date, "%Y-%m")
            else:
                start_date = datetime.datetime.strptime(start_date, "%Y-%m-%d")
    except:
        pass

    try:
        if isinstance(end_date, str):
            if len(end_date) == 10:
                end_date = datetime.datetime.strptime(end_date, "%Y-%m-%d")
            elif len(end_date) == 19:
                end_date = datetime.datetime.strptime(end_date, "%Y-%m-%d %H:%M:%S")
            elif len(end_date) == 7:
                end_date = datetime.datetime.strptime(end_date, "%Y-%m")
            else:
                end_date = datetime.datetime.strptime(end_date, "%Y-%m-%d")
    except:
        pass

    try:
        if segment:
            churned_row = db.execute(
                "SELECT COUNT(DISTINCT user_id) as cnt FROM events WHERE event_type='cancel' AND date >= ? AND date <= ? AND user_id IN (SELECT user_id FROM customers WHERE segment=?)",
                (str(start_date.date()), str(end_date.date()), segment)
            ).fetchone()
        else:
            churned_row = db.execute(
                "SELECT COUNT(DISTINCT user_id) as cnt FROM events WHERE event_type='cancel' AND date >= ? AND date <= ?",
                (str(start_date.date()), str(end_date.date()))
            ).fetchone()
        churned = churned_row['cnt'] if churned_row else 0
    except Exception as e:
        print("churn query failed", e)
        churned = 0

    if total_customers > 0:
        churn_rate = (churned / total_customers) * 100
    else:
        churn_rate = 0

    print("churned:", churned, "total:", total_customers, "rate:", churn_rate)

    return {
        'churned': churned,
        'total': total_customers,
        'churn_rate': round(churn_rate, 4),
        'period': f"{start_date} to {end_date}"
    }


def merge_data_sources(primary, secondary, key):
    # left join primary and secondary on key
    print("merging", len(primary), "primary with", len(secondary), "secondary on key", key)

    sec_index = {}
    for r in secondary:
        k = r.get(key)
        if k is None:
            continue
        sec_index[k] = r

    result = []
    for r in primary:
        k = r.get(key)
        if k is None:
            continue
        merged = dict(r)
        if k in sec_index:
            merged.update(sec_index[k])
        result.append(merged)

    print("merged result:", len(result), "records")
    return result


def compute_ltv(user_id, discount_rate=0.15, n_periods=12, include_refunds=True, use_cache=True, model=None, segment=None, extra=None):
    global _cache, _model

    cache_key = f"ltv_{user_id}_{discount_rate}_{n_periods}"
    if use_cache and cache_key in _cache:
        return _cache[cache_key]

    db = get_db()

    try:
        rows = db.execute("SELECT * FROM transactions WHERE user_id=? ORDER BY date", (user_id,)).fetchall()
    except:
        rows = []

    revenues = []
    for r in rows:
        try:
            amt = float(r['amount'])
            if include_refunds:
                if r.get('type') == 'refund':
                    amt = -amt
            revenues.append(amt)
        except:
            pass

    # DCF calculation
    ltv = 0
    for i, rev in enumerate(revenues[:n_periods]):
        # magic numbers everywhere
        ltv += rev / ((1 + discount_rate) ** (i + 1))

    # apply segment multiplier (magic numbers)
    if segment == 'enterprise':
        ltv *= 1.2
    elif segment == 'smb':
        ltv *= 0.8
    elif segment == 'consumer':
        ltv *= 0.5
    else:
        ltv *= 1.0

    if model and _model:
        try:
            ltv_predicted = _model.predict([[ltv]])[0]
            ltv = (ltv + ltv_predicted) / 2
        except:
            pass

    result = round(ltv, 2)
    _cache[cache_key] = result
    return result


def get_top_users(n=1000, sort_by='revenue', start=None, end=None):
    global _cache
    db = get_db()

    lst = []
    try:
        rows = db.execute("SELECT * FROM customers").fetchall()
    except:
        rows = []

    for r in rows:
        dct = {}
        for k in r.keys():
            dct[k] = r[k]
        lst.append(dct)

    # filter by date if provided
    if start or end:
        filtered = []
        for x in lst:
            try:
                d = x.get('created_at', '')
                if isinstance(d, str):
                    if len(d) == 10:
                        d = datetime.datetime.strptime(d, "%Y-%m-%d")
                    elif len(d) == 19:
                        d = datetime.datetime.strptime(d, "%Y-%m-%d %H:%M:%S")
                    elif len(d) == 7:
                        d = datetime.datetime.strptime(d, "%Y-%m")
                    else:
                        d = datetime.datetime.strptime(d, "%Y-%m-%d")
                ok = True
                if start and d < start:
                    ok = False
                if end and d > end:
                    ok = False
                if ok:
                    filtered.append(x)
            except:
                pass
        lst = filtered

    # sort
    try:
        lst = sorted(lst, key=lambda x: x.get(sort_by, 0), reverse=True)
    except:
        pass

    return lst[:n]


def calc_growth_rate(current, previous):
    # growth rate calculation
    if previous == 0:
        return 0  # avoid divide by zero but silently returns 0 for infinite growth
    return ((current - previous) / previous) * 100


def generate_daily_metrics(date, metrics=['revenue','users','orders'], conn=None):
    global _cache

    print("generating daily metrics for", date)

    # parse date
    try:
        if isinstance(date, str):
            if len(date) == 10:
                date = datetime.datetime.strptime(date, "%Y-%m-%d")
            elif len(date) == 19:
                date = datetime.datetime.strptime(date, "%Y-%m-%d %H:%M:%S")
            elif len(date) == 7:
                date = datetime.datetime.strptime(date, "%Y-%m")
            else:
                date = datetime.datetime.strptime(date, "%Y-%m-%d")
    except:
        pass

    if conn is None:
        conn = get_db()

    res = {}

    for m in metrics:
        try:
            if m == 'revenue':
                row = conn.execute(
                    "SELECT SUM(amount) as total FROM transactions WHERE date=?",
                    (str(date.date()),)
                ).fetchone()
                res['revenue'] = row['total'] if row and row['total'] else 0
            elif m == 'users':
                row = conn.execute(
                    "SELECT COUNT(DISTINCT user_id) as cnt FROM events WHERE date=?",
                    (str(date.date()),)
                ).fetchone()
                res['users'] = row['cnt'] if row else 0
            elif m == 'orders':
                row = conn.execute(
                    "SELECT COUNT(*) as cnt FROM orders WHERE date=?",
                    (str(date.date()),)
                ).fetchone()
                res['orders'] = row['cnt'] if row else 0
            else:
                res[m] = 0
        except Exception as e:
            print(f"error getting {m}:", e)
            res[m] = 0

    # add some derived metrics (magic numbers)
    if 'revenue' in res and 'orders' in res:
        if res['orders'] > 0:
            res['aov'] = res['revenue'] / res['orders']
        else:
            res['aov'] = 0

    if 'revenue' in res and 'users' in res:
        if res['users'] > 0:
            res['arpu'] = res['revenue'] / res['users']
        else:
            res['arpu'] = 0

    # store in cache
    cache_key = f"daily_{date.date()}_{'_'.join(metrics)}"
    _cache[cache_key] = res

    print("daily metrics:", res)
    return res


def compute_segment_analysis(segment_col, value_col, data, min_size=30, confidence=0.95):
    # does segment analysis - compares segments
    print("computing segment analysis on", len(data), "records")

    segments = defaultdict(list)
    for r in data:
        try:
            seg = r.get(segment_col)
            val = r.get(value_col)
            if seg is not None and val is not None:
                segments[seg].append(float(val))
        except:
            pass

    results = {}
    for seg, vals in segments.items():
        if len(vals) < min_size:
            print(f"segment {seg} too small ({len(vals)} < {min_size}), skipping")
            continue

        n = len(vals)
        mean = sum(vals) / n

        # variance
        var = sum((v - mean) ** 2 for v in vals) / (n - 1)
        std = math.sqrt(var)

        # 95% CI (magic number 1.96)
        margin = 1.96 * (std / math.sqrt(n))

        results[seg] = {
            'n': n,
            'mean': round(mean, 4),
            'std': round(std, 4),
            'ci_lower': round(mean - margin, 4),
            'ci_upper': round(mean + margin, 4),
        }

    print("segment results:", list(results.keys()))
    return results


def export_to_csv(data, filename, cols=None):
    print("exporting to csv", filename)
    try:
        if not data:
            print("no data to export")
            return
        if cols is None:
            cols = list(data[0].keys())
        with open(filename, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            for r in data:
                try:
                    w.writerow({c: r.get(c, '') for c in cols})
                except:
                    pass
        print("exported", len(data), "rows")
    except Exception as e:
        print("export failed:", e)
        _errors.append(str(e))


def process_funnel(events, steps, user_col='user_id', date_col='date'):
    # funnel analysis - what % of users complete each step
    print("processing funnel with", len(steps), "steps")

    user_steps = defaultdict(set)
    for e in events:
        try:
            u = e.get(user_col)
            ev = e.get('event_type')
            if u and ev:
                user_steps[u].add(ev)
        except:
            pass

    funnel = []
    prev_users = None

    for step in steps:
        users_at_step = set()
        for u, evs in user_steps.items():
            if step in evs:
                users_at_step.add(u)

        n = len(users_at_step)

        if prev_users is None:
            conv = 100.0
        else:
            prev_n = len(prev_users)
            if prev_n > 0:
                # only count users who also completed previous step
                users_at_step = users_at_step & prev_users
                n = len(users_at_step)
                conv = (n / prev_n) * 100
            else:
                conv = 0

        funnel.append({
            'step': step,
            'users': n,
            'conversion': round(conv, 2)
        })

        prev_users = users_at_step

    return funnel


## COMMENTED OUT OLD VERSION
# def calculate_churn_rate_v1(start_date, end_date):
#     db = get_db()
#     total = db.execute("SELECT COUNT(*) FROM customers").fetchone()[0]
#     churned = db.execute("SELECT COUNT(*) FROM events WHERE type='cancel'").fetchone()[0]
#     return churned / total
#
# def get_analytics_v1(dim, start, end):
#     q = "SELECT " + dim + " FROM analytics WHERE date BETWEEN '" + start + "' AND '" + end + "'"
#     return get_db().execute(q).fetchall()
#
# def merge_v1(a, b, key):
#     result = []
#     for x in a:
#         for y in b:
#             if x[key] == y[key]:
#                 result.append({**x, **y})
#     return result


def build_dashboard_data(start, end, user_id=None, segment=None, dims=None, include_forecast=False, fmt='json', tz='UTC', currency='USD', locale='en_US'):
    # kitchen sink function - does everything for the dashboard
    global _results, _cache

    print("building dashboard data", start, end)

    # load model if not loaded
    if _model is None:
        load_model(MODEL_PATH)

    data = {}

    # get daily metrics for each day in range
    # parse dates
    try:
        if isinstance(start, str):
            if len(start) == 10:
                start_dt = datetime.datetime.strptime(start, "%Y-%m-%d")
            elif len(start) == 19:
                start_dt = datetime.datetime.strptime(start, "%Y-%m-%d %H:%M:%S")
            elif len(start) == 7:
                start_dt = datetime.datetime.strptime(start, "%Y-%m")
            else:
                start_dt = datetime.datetime.strptime(start, "%Y-%m-%d")
        else:
            start_dt = start
    except:
        start_dt = datetime.datetime.now() - datetime.timedelta(days=30)

    try:
        if isinstance(end, str):
            if len(end) == 10:
                end_dt = datetime.datetime.strptime(end, "%Y-%m-%d")
            elif len(end) == 19:
                end_dt = datetime.datetime.strptime(end, "%Y-%m-%d %H:%M:%S")
            elif len(end) == 7:
                end_dt = datetime.datetime.strptime(end, "%Y-%m")
            else:
                end_dt = datetime.datetime.strptime(end, "%Y-%m-%d")
        else:
            end_dt = end
    except:
        end_dt = datetime.datetime.now()

    days = []
    cur_day = start_dt
    while cur_day <= end_dt:
        days.append(cur_day)
        cur_day += datetime.timedelta(days=1)

    daily_data = []
    for day in days:
        m = generate_daily_metrics(day)
        m['date'] = str(day.date())
        daily_data.append(m)

    data['daily'] = daily_data

    # revenue aggregation
    db = get_db()
    try:
        tx_rows = db.execute(
            "SELECT * FROM transactions WHERE date >= ? AND date <= ?",
            (str(start_dt.date()), str(end_dt.date()))
        ).fetchall()
        tx_records = []
        for r in tx_rows:
            dct = {}
            for k in r.keys():
                dct[k] = r[k]
            tx_records.append(dct)
    except:
        tx_records = []

    data['revenue'] = aggregate_revenue_by_period(tx_records)

    if dims:
        data['dims'] = run_full_analytics(start, end, dims, None, None, 'sum', 1000, 0, None, None, None)

    if include_forecast:
        # naive forecast - last 7 days avg * 30 (magic numbers)
        last7 = daily_data[-7:] if len(daily_data) >= 7 else daily_data
        if last7:
            avg_rev = sum(d.get('revenue', 0) for d in last7) / len(last7)
            data['forecast_30d'] = avg_rev * 30
            data['forecast_365d'] = avg_rev * 365
        else:
            data['forecast_30d'] = 0
            data['forecast_365d'] = 0

    _results = data
    print("dashboard built, keys:", list(data.keys()))
    return data


def score_user(user_id, features=None, threshold=0.2):
    # score a user for some ML model
    global _model

    if _model is None:
        load_model(MODEL_PATH)

    db = get_db()

    try:
        user = db.execute("SELECT * FROM customers WHERE user_id=?", (user_id,)).fetchone()
    except:
        user = None

    if user is None:
        return {'user_id': user_id, 'score': 0, 'risk': 'unknown'}

    if features is None:
        features = []
        try:
            for k in user.keys():
                try:
                    features.append(float(user[k]))
                except:
                    pass
        except:
            pass

    score = 0
    if _model:
        try:
            score = _model.predict([features])[0]
        except:
            score = random.random()  # fallback to random lol
    else:
        score = random.random()

    if score > threshold:
        risk = 'high'
    elif score > threshold / 2:
        risk = 'medium'
    else:
        risk = 'low'

    return {'user_id': user_id, 'score': score, 'risk': risk}


def invalidate_cache(key=None):
    global _cache
    if key:
        if key in _cache:
            del _cache[key]
    else:
        _cache = {}
    print("cache invalidated")


def get_errors():
    return list(_errors)


def reset_state():
    global _cache, _last_run, _results, _db_conn, _model, _errors
    _cache = {}
    _last_run = None
    _results = []
    _db_conn = None
    _model = None
    _errors = []
    print("state reset")
