import * as https from 'https';

const ROUTER_BASE_URL = 'https://api.dshub.top';

export interface BalanceInfo {
    success: boolean;
    username?: string;
    quota?: number;          // remaining quota (raw units)
    usedQuota?: number;      // used quota (raw units)
    requestCount?: number;
    group?: string;
    quotaPerUnit?: number;   // units per 1 USD (from /api/status)
    error?: string;
}

export interface LogItem {
    created_at: number;
    type: number;            // 1=topup 2=consume 3=admin 4=system 5=error
    model_name?: string;
    quota?: number;
    prompt_tokens?: number;      // total input tokens (includes cached)
    completion_tokens?: number;  // output tokens
    token_name?: string;
    content?: string;
    use_time?: number;           // upstream latency (seconds)
    is_stream?: boolean;
    // Parsed out of the upstream `other` JSON blob:
    cache_tokens?: number;       // cached input tokens (billed at cache_ratio)
    cache_ratio?: number;        // discount multiplier for cached tokens (e.g. 0.1)
    model_ratio?: number;        // price multiplier for this model
    completion_ratio?: number;   // output/input price multiplier
    reasoning_effort?: string;   // e.g. "xhigh"
    request_path?: string;       // e.g. "/v1/responses"
    ttft?: number;               // time to first token (ms), from `frt`
}

export interface LogsResult {
    success: boolean;
    items?: LogItem[];
    total?: number;
    error?: string;
}

export interface PaymentResult {
    success: boolean;
    payLink?: string;        // hosted checkout page
    orderNo?: string;        // 易支付 order number, for polling
    qrContent?: string;      // string to encode into an in-app QR code
    payMode?: string;        // upstream `mode` (e.g. "redirect")
    browserOnly?: boolean;   // true → open payLink in browser, no in-app QR/polling
    error?: string;
}

export interface OrderStatus {
    paid: boolean;
    message?: string;
    redirectUrl?: string;    // where the gateway wants to redirect on success
    error?: string;
}

/**
 * Module 3: AccountManager
 * Reads the logged-in user's balance and usage logs, and creates top-up
 * orders — all via the upstream New-API endpoints, authenticated with the
 * stored accessToken + New-Api-User header (same scheme as KeyProvisioner).
 *
 * dshub.top runs the 易支付(epay) New-API fork: top-up goes through
 * POST /api/user/pay (channel "alipay"), which returns a hosted checkout
 * page on the payunk.com aggregator. We render the Alipay QR in-app instead
 * and poll the aggregator's orderquery endpoint for completion.
 */
export class AccountManager {
    private readonly baseUrl = ROUTER_BASE_URL;
    private quotaPerUnit = 500000; // fallback; refreshed from /api/status

    /** Remaining + used balance for the current user. */
    async getBalance(accessToken: string, userId: string): Promise<BalanceInfo> {
        try {
            await this.refreshQuotaPerUnit();
            const res = await this.httpGet('/api/user/self', accessToken, userId);
            if (!res.success || !res.data) {
                return { success: false, error: res.message || '获取余额失败' };
            }
            const d = res.data;
            return {
                success: true,
                username: d.username,
                quota: d.quota,
                usedQuota: d.used_quota,
                requestCount: d.request_count,
                group: d.group,
                quotaPerUnit: this.quotaPerUnit,
            };
        } catch (err: any) {
            return { success: false, error: err?.message || '获取余额失败' };
        }
    }

    /** Paged usage logs for the current user (newest first). */
    async getLogs(
        accessToken: string,
        userId: string,
        page = 1,
        pageSize = 20
    ): Promise<LogsResult> {
        try {
            // type=0 → all log types. New-API paginates with p (1-based).
            const path = `/api/log/self?p=${page}&page_size=${pageSize}&type=0`;
            const res = await this.httpGet(path, accessToken, userId);
            if (!res.success) {
                return { success: false, error: res.message || '获取使用记录失败' };
            }
            // New-API returns either {data: [...]} or {data: {items, total}}.
            const data = res.data;
            const rawItems: any[] = Array.isArray(data) ? data : (data?.items || []);
            const items = rawItems.map((it) => this.enrichLogItem(it));
            const total = Array.isArray(data)
                ? data.length
                : (data?.total ?? rawItems.length);
            return { success: true, items, total };
        } catch (err: any) {
            return { success: false, error: err?.message || '获取使用记录失败' };
        }
    }

    /**
     * Flatten the upstream `other` JSON blob (cache tokens, ratios, latency)
     * onto the log item so the renderer doesn't have to re-parse it.
     */
    private enrichLogItem(raw: any): LogItem {
        const item: LogItem = { ...raw };
        let other: any = raw?.other;
        if (typeof other === 'string' && other) {
            try { other = JSON.parse(other); } catch { other = null; }
        }
        if (other && typeof other === 'object') {
            if (typeof other.cache_tokens === 'number') item.cache_tokens = other.cache_tokens;
            if (typeof other.cache_ratio === 'number') item.cache_ratio = other.cache_ratio;
            if (typeof other.model_ratio === 'number') item.model_ratio = other.model_ratio;
            if (typeof other.completion_ratio === 'number') item.completion_ratio = other.completion_ratio;
            if (typeof other.reasoning_effort === 'string') item.reasoning_effort = other.reasoning_effort;
            if (typeof other.request_path === 'string') item.request_path = other.request_path;
            // `frt` is time-to-first-token in ms; -1000 is a "not measured" sentinel.
            if (typeof other.frt === 'number' && other.frt >= 0) item.ttft = other.frt;
        }
        return item;
    }

    /**
     * Preview the real money charged for a given top-up quantity.
     * New-API's `amount` param is a quota quantity, not dollars; the actual
     * price depends on the channel (alipay/epay and Stripe use different
     * price ratios), so we hit the matching amount endpoint.
     * Returns a currency string (e.g. "5.00").
     */
    async getTopupPrice(
        accessToken: string,
        userId: string,
        amount: number,
        channel: string = 'alipay'
    ): Promise<{ success: boolean; price?: string; error?: string }> {
        try {
            const path = channel === 'stripe' ? '/api/user/stripe/amount' : '/api/user/amount';
            const res = await this.httpPost(path, accessToken, userId, { amount });
            if (res.message === 'success' && res.data != null) {
                return { success: true, price: String(res.data) };
            }
            return { success: false, error: (typeof res.data === 'string' ? res.data : res.message) || '获取价格失败' };
        } catch (err: any) {
            return { success: false, error: err?.message || '获取价格失败' };
        }
    }

    /**
     * Create a top-up order.
     * `amount` is the top-up quantity (quota units, min 1) — the real money
     * charged is amount × channel price-ratio (see getTopupPrice).
     *
     * - 'alipay' → 易支付 POST /api/user/pay, returns a payunk checkout page;
     *   we also fetch the qr.alipay.com address for an in-app QR + polling.
     * - 'stripe' → POST /api/user/stripe/pay, returns a Stripe checkout URL
     *   to open directly in the browser (browserOnly).
     */
    async createPayment(
        accessToken: string,
        userId: string,
        amount: number,
        method: string = 'alipay'
    ): Promise<PaymentResult> {
        if (method === 'stripe') {
            return this.createStripePayment(accessToken, userId, amount);
        }
        try {
            const res = await this.httpPost('/api/user/pay', accessToken, userId, {
                amount,
                payment_method: method,
            });
            // epay fork signals success via message==="success"; on failure it
            // returns { message:"error", data:"<reason>" }.
            const ok = res.success === true || res.message === 'success';
            if (!ok) {
                const reason = typeof res.data === 'string' ? res.data : res.message;
                return { success: false, error: reason || '创建支付订单失败' };
            }
            const link = this.pickPayLink(res);
            if (!link) {
                return { success: false, error: '支付链接为空，请稍后重试' };
            }
            const orderNo = this.extractOrderNo(link);
            const result: PaymentResult = {
                success: true,
                payLink: link,
                payMode: res.mode,
                orderNo: orderNo || undefined,
            };
            // For Alipay, fetch the real qr.alipay.com address the checkout
            // page would have shown, so we can render the QR in-app.
            if (orderNo && method === 'alipay') {
                const qr = await this.fetchAlipayQrContent(orderNo);
                if (qr) result.qrContent = qr;
            }
            return result;
        } catch (err: any) {
            return { success: false, error: err?.message || '创建支付订单失败' };
        }
    }

    /**
     * Stripe checkout: returns a hosted Stripe URL to open in the browser.
     * Requires the gateway's Stripe keys to be configured server-side; if not,
     * the upstream returns "拉起支付失败" and we surface that to the user.
     */
    private async createStripePayment(
        accessToken: string,
        userId: string,
        amount: number
    ): Promise<PaymentResult> {
        try {
            const res = await this.httpPost('/api/user/stripe/pay', accessToken, userId, {
                amount,
                payment_method: 'stripe',
            });
            const ok = res.success === true || res.message === 'success';
            if (!ok) {
                const reason = typeof res.data === 'string' ? res.data : res.message;
                const hint = reason === '拉起支付失败'
                    ? 'Stripe 支付暂不可用（网关未配置），请改用支付宝或联系管理员'
                    : reason;
                return { success: false, error: hint || '创建支付订单失败' };
            }
            const link = this.pickPayLink(res);
            if (!link) {
                return { success: false, error: '支付链接为空，请稍后重试' };
            }
            return { success: true, payLink: link, payMode: res.mode, browserOnly: true };
        } catch (err: any) {
            return { success: false, error: err?.message || '创建支付订单失败' };
        }
    }
    async queryOrder(orderNo: string): Promise<OrderStatus> {
        try {
            const res = await this.httpGetAbsolute(
                `https://api2.payunk.com/pay/orderquery.html?order_no=${encodeURIComponent(orderNo)}`
            );
            // code 200 = paid; 100 = created/pending.
            const code = Number(res?.code);
            if (code === 200) {
                return { paid: true, message: res.msg, redirectUrl: res.url };
            }
            return { paid: false, message: res?.msg };
        } catch (err: any) {
            return { paid: false, error: err?.message || '查询订单失败' };
        }
    }

    /** order_no is carried as a query param on the checkout URL. */
    private extractOrderNo(link: string): string | null {
        try {
            return new URL(link).searchParams.get('order_no');
        } catch {
            const m = link.match(/order_no=([^&]+)/);
            return m ? decodeURIComponent(m[1]) : null;
        }
    }

    /**
     * The checkout page encodes alipayprecreate.html?order_no=... into its QR,
     * which itself redirects/returns the real qr.alipay.com address. We fetch
     * that text so the in-app QR points straight at Alipay.
     */
    private async fetchAlipayQrContent(orderNo: string): Promise<string | null> {
        try {
            const body = await this.httpGetText(
                `https://api2.payunk.com/pay/alipayprecreate.html?order_no=${encodeURIComponent(orderNo)}`
            );
            const text = body.trim();
            const m = text.match(/https?:\/\/qr\.alipay\.com\/\S+/);
            if (m) return m[0];
            // Fallback: encode the precreate URL itself (still scannable).
            if (/^https?:\/\//.test(text)) return text;
            return null;
        } catch {
            return null;
        }
    }

    /** Pull a checkout URL out of an arbitrarily-shaped pay response. */
    private pickPayLink(res: any): string | null {
        if (!res) return null;
        // epay returns the link at the top level (res.url).
        if (typeof res.url === 'string' && res.url) return res.url;
        const data = res.data;
        if (!data) return null;
        if (typeof data === 'string' && /^https?:\/\//.test(data)) return data;
        return data.pay_link || data.url || data.payment_url || data.checkout_url || null;
    }

    /** Read quota_per_unit from public /api/status (no auth needed). */
    private async refreshQuotaPerUnit(): Promise<void> {
        try {
            const res = await this.httpGetPublic('/api/status');
            const v = res?.data?.quota_per_unit;
            if (typeof v === 'number' && v > 0) this.quotaPerUnit = v;
        } catch {
            /* keep fallback */
        }
    }

    private httpGet(path: string, accessToken: string, userId: string): Promise<any> {
        return this.request(path, 'GET', { accessToken, userId });
    }

    private httpPost(path: string, accessToken: string, userId: string, body: any): Promise<any> {
        return this.request(path, 'POST', { accessToken, userId, body });
    }

    private httpGetPublic(path: string): Promise<any> {
        return this.request(path, 'GET', {});
    }

    /** GET an absolute URL (different host) and parse JSON. */
    private async httpGetAbsolute(absUrl: string): Promise<any> {
        const text = await this.httpGetText(absUrl);
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`JSON 解析失败: ${text.slice(0, 200)}`);
        }
    }

    /** GET an absolute URL and return the raw response body as text. */
    private httpGetText(absUrl: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const url = new URL(absUrl);
            const reqOptions: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    Accept: '*/*',
                },
            };
            const req = https.request(reqOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve(data));
            });
            req.on('error', (err) => reject(new Error(`网络请求失败: ${err.message}`)));
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });
            req.end();
        });
    }

    private request(
        path: string,
        method: 'GET' | 'POST',
        opts: { accessToken?: string; userId?: string; body?: any }
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            const url = new URL(`${this.baseUrl}${path}`);
            const bodyStr = opts.body != null ? JSON.stringify(opts.body) : undefined;
            const headers: Record<string, string> = { Accept: 'application/json' };
            if (opts.accessToken) headers['Authorization'] = `Bearer ${opts.accessToken}`;
            if (opts.userId) headers['New-Api-User'] = opts.userId;
            if (bodyStr) {
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
            }

            const reqOptions: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method,
                headers,
            };

            const req = https.request(reqOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        reject(new Error(`JSON 解析失败: ${data.slice(0, 200)}`));
                    }
                });
            });

            req.on('error', (err) => reject(new Error(`网络请求失败: ${err.message}`)));
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });
            if (bodyStr) req.write(bodyStr);
            req.end();
        });
    }
}
