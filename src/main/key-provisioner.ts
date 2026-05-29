import * as https from 'https';

const ROUTER_BASE_URL = 'https://api.dshub.top';

export interface ProvisionResult {
    success: boolean;
    claudeKey?: string;
    codexKey?: string;
    error?: string;
}

export interface CreateTokenOptions {
    name: string;
    group: string;
    expiredTime?: number;  // -1 = never expire
    unlimitedQuota?: boolean;
}

/**
 * Module 2: KeyProvisioner
 * Independent API Key creation module. Only depends on accessToken.
 * Reusable by any context (e.g., future auto-create keys for new channel groups).
 */
export class KeyProvisioner {
    private readonly baseUrl = ROUTER_BASE_URL;

    /**
     * Core method: Create a set of API Keys (Claude + Codex) using accessToken.
     * Idempotent: reuses existing tokens if they already exist.
     */
    async provisionKeys(accessToken: string, userId: string): Promise<ProvisionResult> {
        try {
            // Create Claude Key (group: AppClaude)
            const claudeKey = await this.createToken(accessToken, userId, {
                name: 'TokenWave-Claude',
                group: 'AppClaude',
                expiredTime: -1,
                unlimitedQuota: true,
            });

            // Create Codex Key (group: AppCodex)
            const codexKey = await this.createToken(accessToken, userId, {
                name: 'TokenWave-Codex',
                group: 'AppCodex',
                expiredTime: -1,
                unlimitedQuota: true,
            });

            return { success: true, claudeKey, codexKey };
        } catch (err: any) {
            return { success: false, error: err?.message || 'Key 创建失败' };
        }
    }

    /**
     * Reusable single token creation method.
     * 1. Look up existing token by name (idempotent)
     * 2. If found, return its full (un-masked) key
     * 3. If not, create new token and resolve its full key
     */
    async createToken(accessToken: string, userId: string, options: CreateTokenOptions): Promise<string> {
        // Step 1: Look up existing token (idempotent path)
        const existing = await this.findToken(accessToken, userId, options.name);
        if (existing) {
            const fullKey = await this.resolveFullKey(accessToken, userId, existing);
            if (fullKey) return fullKey;
            // Fall through: existing token's key isn't recoverable in plaintext,
            // create a new one (with a -<timestamp> suffix to avoid collision)
        }

        const tokenName = existing ? `${options.name}-${Date.now()}` : options.name;

        // Step 2: Create new token
        const createResult = await this.httpPost('/api/token/', accessToken, userId, {
            name: tokenName,
            group: options.group,
            expired_time: options.expiredTime ?? -1,
            remain_quota: 0,
            unlimited_quota: options.unlimitedQuota ?? true,
            model_limits_enabled: false,
            model_limits: '',
            cross_group_retry: false,
        });

        if (!createResult.success) {
            throw new Error(createResult.message || `创建 Token "${tokenName}" 失败`);
        }

        console.log('[KeyProvisioner] create response:',
            JSON.stringify(createResult).slice(0, 500));

        // Some New-API forks return the full key directly in the create response
        const directKey = this.extractKeyFromCreateResponse(createResult);
        if (directKey && !this.isMaskedKey(directKey)) {
            return directKey;
        }

        // Step 3: Look up the newly created token, then fetch its full key
        await new Promise(r => setTimeout(r, 500));
        const created = await this.findToken(accessToken, userId, tokenName);
        if (!created) {
            throw new Error(`Token "${tokenName}" 创建后未能获取 key`);
        }
        const fullKey = await this.resolveFullKey(accessToken, userId, created);
        if (!fullKey) {
            throw new Error(`Token "${tokenName}" 已创建但获取明文 key 失败`);
        }
        return fullKey;
    }

    /**
     * Find a token by exact name (latest by created_time). Returns the raw
     * token object (key may be masked) or null. Caller must call
     * resolveFullKey() to get a usable key string.
     */
    private async findToken(accessToken: string, userId: string, tokenName: string): Promise<any | null> {
        const encodedName = encodeURIComponent(tokenName);
        const result = await this.httpGet(
            `/api/token/search?keyword=${encodedName}`,
            accessToken,
            userId
        );

        if (result.success && result.data) {
            const items = result.data.items || result.data;
            if (Array.isArray(items)) {
                const matched = items
                    .filter((t: any) => t.name === tokenName)
                    .sort((a: any, b: any) => (b.created_time || 0) - (a.created_time || 0));
                if (matched.length > 0) return matched[0];
            }
        }
        return null;
    }

    /**
     * Return a usable (full, un-masked) key string for a token. Some New-API
     * deployments mask keys (e.g. "VGPt**********UNca") on every list/detail
     * endpoint and only expose plaintext via a dedicated /key endpoint that
     * the admin UI's "copy" button uses. We try the standard endpoints first
     * for backwards-compat, then fall back to /api/token/{id}/key.
     */
    private async resolveFullKey(accessToken: string, userId: string, token: any): Promise<string | null> {
        console.log('[KeyProvisioner] resolveFullKey: token =',
            JSON.stringify({ id: token.id, name: token.name, key: token.key }));
        if (token.key && !this.isMaskedKey(token.key)) {
            return token.key;
        }
        if (token.id == null) return null;

        // Try the detail endpoint first — some forks return plaintext here.
        const detail = await this.httpGet(`/api/token/${token.id}`, accessToken, userId);
        console.log('[KeyProvisioner] /api/token/{id} response:',
            JSON.stringify(detail).slice(0, 500));

        const detailKey = this.pickKey(detail?.data);
        if (detailKey && !this.isMaskedKey(detailKey)) return detailKey;

        // Fallback: dshub-style dedicated /key endpoint, equivalent to the
        // admin UI's "copy" button. Returns plaintext key.
        // Must be POST — GET hits the OpenAI-compatible proxy router.
        const keyResp = await this.httpPost(`/api/token/${token.id}/key`, accessToken, userId, {});
        console.log('[KeyProvisioner] /api/token/{id}/key response:',
            JSON.stringify(keyResp).slice(0, 300));

        const direct = this.pickKey(keyResp?.data);
        if (direct && !this.isMaskedKey(direct)) return direct;

        return null;
    }

    /** Pull the key string out of an arbitrarily-shaped data field. */
    private pickKey(data: any): string | null {
        if (!data) return null;
        if (typeof data === 'string') return data;
        if (typeof data.key === 'string') return data.key;
        if (typeof data.token === 'string') return data.token;
        return null;
    }

    /** A key string is considered masked if it contains '*'. */
    private isMaskedKey(key: string): boolean {
        return typeof key === 'string' && key.includes('*');
    }

    /**
     * Some New-API forks return the new token's full key directly in the
     * create response (under data, data.key, or data.token). Handle the
     * common shapes; return null if none match.
     */
    private extractKeyFromCreateResponse(createResult: any): string | null {
        const data = createResult?.data;
        if (typeof data === 'string') return data;
        if (data?.key && typeof data.key === 'string') return data.key;
        if (data?.token && typeof data.token === 'string') return data.token;
        return null;
    }

    /**
     * HTTP GET request with Bearer token authentication.
     */
    private httpGet(path: string, accessToken: string, userId: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const url = new URL(`${this.baseUrl}${path}`);
            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'New-Api-User': userId,
                    'Accept': 'application/json',
                },
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch {
                        reject(new Error(`JSON 解析失败: ${body.slice(0, 200)}`));
                    }
                });
            });

            req.on('error', (err) => reject(new Error(`网络请求失败: ${err.message}`)));
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });
            req.end();
        });
    }

    /**
     * HTTP POST request with Bearer token authentication.
     */
    private httpPost(path: string, accessToken: string, userId: string, body: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const url = new URL(`${this.baseUrl}${path}`);
            const bodyStr = JSON.stringify(body);
            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'New-Api-User': userId,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(bodyStr),
                    'Accept': 'application/json',
                },
            };

            const req = https.request(options, (res) => {
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
            req.write(bodyStr);
            req.end();
        });
    }
}
