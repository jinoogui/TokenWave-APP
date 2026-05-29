import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ConfigStore } from './config-store';

interface ScanResult {
    claude: {
        found: boolean;
        path: string;
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        hooksCount?: number;
        permissionsAllow?: number;
    };
    codex: {
        found: boolean;
        configPath: string;
        authPath: string;
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        mcpServersCount?: number;
        projectsCount?: number;
    };
}

const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const claudeJsonPath = path.join(os.homedir(), '.claude.json');
const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml');
const codexAuthPath = path.join(os.homedir(), '.codex', 'auth.json');

function countTomlSections(toml: string, prefix: string): number {
    const re = new RegExp(`^\\[${prefix}\\.[^\\]]+\\]\\s*$`, 'gm');
    return (toml.match(re) || []).length;
}

function extractTomlValue(toml: string, key: string, section?: string): string | undefined {
    // Find the section start; if no section requested, search before any '['.
    let scope = toml;
    if (section) {
        const sectionRe = new RegExp(`^\\[${section.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\]\\s*$`, 'm');
        const m = sectionRe.exec(toml);
        if (!m) return undefined;
        const start = m.index + m[0].length;
        const nextSection = toml.slice(start).search(/^\[/m);
        scope = nextSection === -1 ? toml.slice(start) : toml.slice(start, start + nextSection);
    } else {
        const firstSection = toml.search(/^\[/m);
        scope = firstSection === -1 ? toml : toml.slice(0, firstSection);
    }
    const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, 'm');
    const m = re.exec(scope);
    return m ? m[1] : undefined;
}

export class LocalConfigImporter {
    constructor(
        private configStore: ConfigStore,
        private appDataDir: string,
    ) {}

    /**
     * Inspect the user's native ~/.claude and ~/.codex configs without
     * making any changes. Returns a summary the renderer can show as
     * a confirmation preview before apply().
     */
    scan(): ScanResult {
        const result: ScanResult = {
            claude: { found: false, path: claudeSettingsPath },
            codex: { found: false, configPath: codexConfigPath, authPath: codexAuthPath },
        };

        if (fs.existsSync(claudeSettingsPath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
                const env = raw.env || {};
                result.claude.found = true;
                result.claude.apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
                result.claude.baseUrl = env.ANTHROPIC_BASE_URL;
                result.claude.model = env.ANTHROPIC_MODEL || raw.model;
                result.claude.hooksCount = Object.keys(raw.hooks || {}).length;
                result.claude.permissionsAllow = (raw.permissions?.allow || []).length;
            } catch (e) {
                console.warn('[LocalConfigImporter] Failed to parse ~/.claude/settings.json:', e);
            }
        }

        if (fs.existsSync(codexConfigPath)) {
            try {
                const toml = fs.readFileSync(codexConfigPath, 'utf-8');
                result.codex.found = true;
                result.codex.model = extractTomlValue(toml, 'model');
                const provider = extractTomlValue(toml, 'model_provider');
                if (provider) {
                    result.codex.baseUrl = extractTomlValue(toml, 'base_url', `model_providers.${provider}`);
                }
                result.codex.mcpServersCount = countTomlSections(toml, 'mcp_servers');
                result.codex.projectsCount = countTomlSections(toml, 'projects');
            } catch (e) {
                console.warn('[LocalConfigImporter] Failed to read ~/.codex/config.toml:', e);
            }

            if (fs.existsSync(codexAuthPath)) {
                try {
                    const auth = JSON.parse(fs.readFileSync(codexAuthPath, 'utf-8'));
                    result.codex.apiKey = auth.OPENAI_API_KEY;
                } catch (e) {
                    console.warn('[LocalConfigImporter] Failed to parse ~/.codex/auth.json:', e);
                }
            }
        }

        return result;
    }

    /**
     * Apply the scan result. Stores api keys / base URLs / models in
     * ConfigStore and copies hooks + MCP server configs into the
     * TokenWave-private claude-home / codex-home so the bundled tools
     * inherit the user's native setup on next launch.
     */
    async apply(scan: ScanResult): Promise<{ applied: string[] }> {
        const applied: string[] = [];

        if (scan.claude.found) {
            if (scan.claude.apiKey) {
                this.configStore.setApiKey('anthropic', scan.claude.apiKey);
                applied.push('Claude API key');
            }
            if (scan.claude.baseUrl) {
                this.configStore.setBaseUrl('anthropic', scan.claude.baseUrl);
                applied.push('Claude base URL');
            }
            if (scan.claude.model) {
                this.configStore.setModel('anthropic', scan.claude.model);
                applied.push('Claude model');
            }

            // Copy the full settings.json into TokenWave's claude-home so
            // hooks/permissions are picked up by the bundled CC. ToolManager
            // overwrites env.ANTHROPIC_* fields on launch with our own
            // ConfigStore values, so user prefs (hooks etc.) survive.
            try {
                const claudeHomeDir = path.join(this.appDataDir, 'claude-home');
                fs.mkdirSync(claudeHomeDir, { recursive: true });
                fs.copyFileSync(claudeSettingsPath, path.join(claudeHomeDir, 'settings.json'));
                applied.push(`Claude hooks (${scan.claude.hooksCount || 0})`);
                if (fs.existsSync(claudeJsonPath)) {
                    fs.copyFileSync(claudeJsonPath, path.join(claudeHomeDir, '.claude.json'));
                }
            } catch (e) {
                console.warn('[LocalConfigImporter] Failed to copy claude config:', e);
            }
        }

        if (scan.codex.found) {
            if (scan.codex.apiKey) {
                this.configStore.setApiKey('openai', scan.codex.apiKey);
                applied.push('Codex API key');
            }
            if (scan.codex.baseUrl) {
                this.configStore.setBaseUrl('openai', scan.codex.baseUrl);
                applied.push('Codex base URL');
            }
            if (scan.codex.model) {
                this.configStore.setModel('openai', scan.codex.model);
                applied.push('Codex model');
            }

            // Copy config.toml: ToolManager's preserveUserConfig() keeps
            // [mcp_servers.*], [projects.*], etc. while regenerating
            // host-controlled keys on next launch.
            try {
                const codexHomeDir = path.join(this.appDataDir, 'codex-home');
                fs.mkdirSync(codexHomeDir, { recursive: true });
                fs.copyFileSync(codexConfigPath, path.join(codexHomeDir, 'config.toml'));
                if (scan.codex.mcpServersCount) {
                    applied.push(`Codex MCP servers (${scan.codex.mcpServersCount})`);
                }
                if (fs.existsSync(codexAuthPath)) {
                    fs.copyFileSync(codexAuthPath, path.join(codexHomeDir, 'auth.json'));
                }
            } catch (e) {
                console.warn('[LocalConfigImporter] Failed to copy codex config:', e);
            }
        }

        this.configStore.set('firstLaunch', false);
        return { applied };
    }
}
