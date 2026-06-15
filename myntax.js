const axios = require('axios');
const dns = require('dns');
const { URL } = require('url');
const { EmbedBuilder } = require('discord.js');

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const RESERVED_VARIABLES = new Set(['user', 'target', 'local', 'server', 'msg', 'env', 'settings', 'main', 'getBank', 'suppressErrors', 'initialSettings']);
const MAX_SCRIPT_SIZE_BYTES = 50 * 1024;
const MAX_LINES = 1000;
const MAX_COMMAND_COUNT = 500;
const MAX_EXECUTION_TIME_MS = 2000;
const MAX_RESPONSE_SIZE_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 3000;
const MAX_DISCORD_MSG_LENGTH = 1990;

const TOKEN_REGEX = /\s*(&&|\|\||==|!=|<=|>=|[+\-*/%()<>!,])|\s*("[^"]*"|'[^']*')|\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)|\s*(\d+(?:\.\d+)?)\s*/g;
const VAR_REGEX = /<([\w.]+)>/g;

const jsonCache = new Map();

function safeJsonParse(str) {
    if (!str || typeof str !== 'string') return {};
    if (jsonCache.has(str)) return jsonCache.get(str);
    try {
        const parsed = JSON.parse(str);
        if (jsonCache.size > 500) {
            const firstKey = jsonCache.keys().next().value;
            jsonCache.delete(firstKey);
        }
        jsonCache.set(str, parsed);
        return parsed;
    } catch {
        return {};
    }
}

function isPrivateOrLocalIp(ip) {
    if (!ip) return true;
    if (ip === '0.0.0.0' || ip === '::' || ip === 'localhost') return true;
    const parts = ip.split('.');
    if (parts.length === 4) {
        const first = parseInt(parts[0], 10);
        const second = parseInt(parts[1], 10);
        if (first === 127 || first === 10 || first === 0) return true;
        if (first === 172 && (second >= 16 && second <= 31)) return true;
        if (first === 192 && second === 168) return true;
        if (first === 169 && second === 254) return true;
    } else if (ip.includes(':')) {
        const cleanIp = ip.toLowerCase();
        if (cleanIp === '::1') return true;
        if (cleanIp.startsWith('fe80:') || cleanIp.startsWith('fc00:') || cleanIp.startsWith('fd00:')) return true;
    }
    return false;
}

function lookupIp(hostname) {
    return new Promise((resolve) => {
        dns.lookup(hostname, { family: 4 }, (err, address) => {
            if (err) {
                dns.lookup(hostname, { family: 6 }, (err6, address6) => {
                    if (err6) resolve(null);
                    else resolve(address6);
                });
            } else {
                resolve(address);
            }
        });
    });
}

function tokenize(expr) {
    const tokens = [];
    for (const match of expr.matchAll(TOKEN_REGEX)) {
        if (match[1]) {
            tokens.push({ type: 'OP', value: match[1] });
        } else if (match[2]) {
            tokens.push({ type: 'STR', value: match[2].slice(1, -1) });
        } else if (match[3]) {
            const val = match[3];
            if (val === 'true') tokens.push({ type: 'BOOL', value: true });
            else if (val === 'false') tokens.push({ type: 'BOOL', value: false });
            else if (val === 'null') tokens.push({ type: 'NULL', value: null });
            else tokens.push({ type: 'VAR', value: val });
        } else if (match[4]) {
            tokens.push({ type: 'NUM', value: parseFloat(match[4]) });
        }
    }
    return tokens;
}

function parseAndEvaluate(expr, user, target, localVars, serverVars, env, settings) {
    const tokens = tokenize(expr);
    let index = 0;

    function peek() {
        return tokens[index];
    }

    function consume() {
        return tokens[index++];
    }

    function resolveNestedValue(path) {
        const parts = path.split('.');
        const baseKey = parts[0];
        if (FORBIDDEN_KEYS.has(baseKey)) return undefined;

        let current;
        if (baseKey === 'user') current = user;
        else if (baseKey === 'target') current = target;
        else if (baseKey === 'local') current = localVars;
        else if (baseKey === 'server') current = serverVars;
        else if (env[baseKey] !== undefined) current = env[baseKey];
        else if (user[baseKey] !== undefined) current = user[baseKey];
        else if (settings[baseKey] !== undefined) current = settings[baseKey];

        for (let i = 1; i < parts.length; i++) {
            if (typeof current === 'string' && (current.startsWith('{') || current.startsWith('['))) {
                current = safeJsonParse(current);
            }
            const part = parts[i];
            if (FORBIDDEN_KEYS.has(part)) return undefined;
            if (current === null || current === undefined || typeof current !== 'object') {
                return undefined;
            }
            current = current[part];
        }
        return current;
    }

    function parsePrimary() {
        const token = consume();
        if (!token) throw new Error("Unexpected end of expression");
        if (token.type === 'NUM' || token.type === 'STR' || token.type === 'BOOL' || token.type === 'NULL') {
            return token.value;
        }
        if (token.type === 'VAR') {
            const next = peek();
            if (next && next.type === 'OP' && next.value === '(') {
                consume();
                const args = [];
                if (peek() && peek().value !== ')') {
                    args.push(parseExpression(0));
                    while (peek() && peek().value === ',') {
                        consume();
                        args.push(parseExpression(0));
                    }
                }
                const close = consume();
                if (!close || close.value !== ')') throw new Error("Expected matching closing parenthesis");

                if (token.value === 'Math.random') return Math.random();
                if (token.value === 'Math.floor' && args.length === 1) return Math.floor(args[0]);
                if (token.value === 'Math.round' && args.length === 1) return Math.round(args[0]);
                if (token.value === 'Math.ceil' && args.length === 1) return Math.ceil(args[0]);
                if (token.value === 'Math.abs' && args.length === 1) return Math.abs(args[0]);
                if (token.value === 'Math.min') return Math.min(...args);
                if (token.value === 'Math.max') return Math.max(...args);
                if (token.value === 'String.toUpperCase' && args.length === 1) return String(args[0]).toUpperCase();
                if (token.value === 'String.toLowerCase' && args.length === 1) return String(args[0]).toLowerCase();
                if (token.value === 'String.length' && args.length === 1) return String(args[0]).length;
                if (token.value === 'String.replace' && args.length === 3) return String(args[0]).replace(new RegExp(args[1], 'g'), args[2]);

                throw new Error(`Unsupported function: ${token.value}`);
            }
            const resolved = resolveNestedValue(token.value);
            if (resolved !== undefined) {
                return isNaN(resolved) ? resolved : Number(resolved);
            }
            return token.value;
        }
        if (token.type === 'OP' && token.value === '(') {
            const val = parseExpression(0);
            const next = consume();
            if (!next || next.value !== ')') throw new Error("Expected matching closing parenthesis");
            return val;
        }
        if (token.type === 'OP' && token.value === '!') return !parsePrimary();
        if (token.type === 'OP' && token.value === '-') return -parsePrimary();
        throw new Error(`Unexpected syntax element: ${token.value}`);
    }

    const precedence = {
        '||': 1, '&&': 2,
        '==': 3, '!=': 3,
        '<': 4, '<=': 4, '>': 4, '>=': 4,
        '+': 5, '-': 5,
        '*': 6, '/': 6, '%': 6
    };

    function parseExpression(minPrec) {
        let left = parsePrimary();
        while (true) {
            const token = peek();
            if (!token || token.type !== 'OP' || precedence[token.value] === undefined) break;
            const op = token.value;
            const prec = precedence[op];
            if (prec < minPrec) break;
            consume();
            const right = parseExpression(prec + 1);
            left = applyOp(op, left, right);
        }
        return left;
    }

    function applyOp(op, a, b) {
        const norm = (v) => {
            if (v === true || v === 'true') return true;
            if (v === false || v === 'false') return false;
            return v;
        };
        switch (op) {
            case '||': return norm(a) || norm(b);
            case '&&': return norm(a) && norm(b);
            case '==': return norm(a) == norm(b);
            case '!=': return norm(a) != norm(b);
            case '<': return a < b;
            case '<=': return a <= b;
            case '>': return a > b;
            case '>=': return a >= b;
            case '+': return a + b;
            case '-': return a - b;
            case '*': return a * b;
            case '/': return b === 0 ? 0 : a / b;
            case '%': return b === 0 ? 0 : a % b;
            default: throw new Error(`Operator error: ${op}`);
        }
    }

    if (tokens.length === 0) return null;
    const result = parseExpression(0);
    if (index < tokens.length) throw new Error("Unexpected token or missing operator");
    return result;
}

function resolvePath(user, target, localVars, serverVars, env, settings, msg, query, queryEncoded, path) {
    const parts = path.split('.');
    const baseKey = parts[0];
    if (FORBIDDEN_KEYS.has(baseKey)) return '';

    let current;
    if (baseKey === 'user') current = user;
    else if (baseKey === 'target') current = target;
    else if (baseKey === 'local') current = localVars;
    else if (baseKey === 'server') current = serverVars;
    else if (baseKey === 'msg') current = msg;
    else if (baseKey === 'query') current = query;
    else if (baseKey === 'queryEncoded') current = queryEncoded;
    else if (env[baseKey] !== undefined) current = env[baseKey];
    else if (user[baseKey] !== undefined) current = user[baseKey];
    else if (settings[baseKey] !== undefined) current = settings[baseKey];

    for (let i = 1; i < parts.length; i++) {
        if (typeof current === 'string' && (current.startsWith('{') || current.startsWith('['))) {
            current = safeJsonParse(current);
        }
        const part = parts[i];
        if (FORBIDDEN_KEYS.has(part)) return '';
        if (current === null || current === undefined || typeof current !== 'object') return '';
        current = current[part];
    }

    if (current === null || current === undefined) return '';
    if (typeof current === 'object') return JSON.stringify(current);
    return String(current);
}

function cleanNumeric(valStr) {
    const cleaned = valStr.replace(/[$,\s]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : Math.round(num);
}

function updateDbUserField(userId, field, value, db) {
    return new Promise((resolve, reject) => {
        db.run(`UPDATE users SET ${field} = ? WHERE id = ?`, [value, userId], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

async function runMyntax(script, msg, user, suppressErrors, getBank, db, initialSettings = {}) {
    const startTime = Date.now();
    let env = {}, settings = initialSettings;

    if (!script || typeof script !== 'string') return;
    if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_SIZE_BYTES) {
        if (!suppressErrors) await msg.reply("❌ Script limit exceeded: File size is too large.");
        return;
    }

    const lines = script.split('\n');
    if (lines.length > MAX_LINES) {
        if (!suppressErrors) await msg.reply("❌ Script limit exceeded: Line count too high.");
        return;
    }

    let target = null;
    const mention = msg && msg.mentions && msg.mentions.users && msg.mentions.users.first();
    if (mention) {
        await new Promise((resolvePromise) => {
            db.run('INSERT OR IGNORE INTO users (id) VALUES (?)', [mention.id], () => {
                db.get('SELECT * FROM users WHERE id = ?', [mention.id], (err, row) => {
                    if (row) target = row;
                    resolvePromise();
                });
            });
        });
    }

    const serverId = msg && msg.guild ? msg.guild.id : 'dm';
    const serverVars = {};
    await new Promise((resolvePromise) => {
        db.all('SELECT key, value FROM server_vars WHERE server_id = ?', [serverId], (err, rows) => {
            if (rows) {
                for (const row of rows) serverVars[row.key] = row.value;
            }
            resolvePromise();
        });
    });

    let localVars = {};
    const query = msg && msg.content ? msg.content.trim().split(/\s+/).slice(1).join(' ') : '';
    const queryEncoded = encodeURIComponent(query);

    async function resolve(str) {
        let res = str;
        if (res.includes('<main.bank>')) {
            const bankVal = String(await getBank?.() || 0);
            res = res.replace(/<main\.bank>/g, bankVal);
        }
        res = res.replace(VAR_REGEX, (match, p1) => {
            return resolvePath(user, target, localVars, serverVars, env, settings, msg, query, queryEncoded, p1);
        });
        return res;
    }

    let commandCount = 0;
    for (let i = 0; i < lines.length; i++) {
        if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
            if (!suppressErrors) await msg.reply("❌ Timeout: Custom command execution exceeded maximum duration.");
            return;
        }
        let line = lines[i].trim();
        if (!line) continue;
        commandCount++;
        if (commandCount > MAX_COMMAND_COUNT) {
            if (!suppressErrors) await msg.reply("❌ Limit: Exceeded maximum command operations allowed.");
            return;
        }

        try {
            if (line.startsWith('$if ')) {
                let condStr = line.slice(4).replace(/\{$/, '').trim();
                condStr = condStr.replace(/\band\b/g, '&&').replace(/\bor\b/g, '||');
                const resolvedCondition = await resolve(condStr);
                let isTrue = false;
                try {
                    isTrue = !!parseAndEvaluate(resolvedCondition, user, target, localVars, serverVars, env, settings);
                } catch { isTrue = false; }

                if (!isTrue) {
                    let braceDepth = 0;
                    let found = false;
                    while (i < lines.length) {
                        const currentLine = lines[i];
                        for (const char of currentLine) {
                            if (char === '{') braceDepth++;
                            else if (char === '}') braceDepth--;
                        }

                        if (braceDepth <= 0) {
                            found = true;
                            break;
                        }
                        i++;
                    }
                    if (!found) break;
                }
            } else if (line.startsWith('$set ')) {
                const parts = line.slice(5).split(' ');
                const varName = parts[0];
                if (RESERVED_VARIABLES.has(varName) || FORBIDDEN_KEYS.has(varName)) throw new Error(`Assignment rejected: ${varName} is a reserved system variable.`);
                const resolvedVal = await resolve(parts.slice(1).join(' '));
                if (varName === 'user.wallet' || varName === 'user.bank') {
                    const fieldName = varName === 'user.wallet' ? 'wallet' : 'bank';
                    const numericValue = cleanNumeric(resolvedVal);
                    await updateDbUserField(user.id, fieldName, numericValue, db);
                    user[fieldName] = numericValue;
                    env[varName] = String(numericValue);
                } else if (varName === 'target.wallet' || varName === 'target.bank') {
                    if (target) {
                        const fieldName = varName === 'target.wallet' ? 'wallet' : 'bank';
                        const numericValue = cleanNumeric(resolvedVal);
                        await updateDbUserField(target.id, fieldName, numericValue, db);
                        target[fieldName] = numericValue;
                        env[varName] = String(numericValue);
                    }
                } else if (varName.startsWith('server.')) {
                    const keyName = varName.slice(7);
                    if (!FORBIDDEN_KEYS.has(keyName)) {
                        await new Promise((resolvePromise, rejectPromise) => {
                            db.run('INSERT OR REPLACE INTO server_vars (server_id, key, value) VALUES (?, ?, ?)', [serverId, keyName, resolvedVal], (err) => {
                                if (err) rejectPromise(err);
                                else resolvePromise();
                            });
                        });
                        serverVars[keyName] = resolvedVal;
                        env[varName] = resolvedVal;
                    }
                } else env[varName] = resolvedVal;
            } else if (line.startsWith('$local ')) {
                const parts = line.slice(7).split(' ');
                const varName = parts[0];
                if (FORBIDDEN_KEYS.has(varName)) throw new Error(`Assignment rejected: ${varName} is forbidden.`);
                const resolvedVal = await resolve(parts.slice(1).join(' '));
                localVars[varName] = resolvedVal;
            } else if (line.startsWith('$formatcash ')) {
                const parts = line.slice(12).split(' ');
                const varName = parts[0];
                if (RESERVED_VARIABLES.has(varName) || FORBIDDEN_KEYS.has(varName)) throw new Error(`Assignment rejected: ${varName} is a reserved system variable.`);
                const rawVal = await resolve(parts.slice(1).join(' '));
                const num = parseFloat(rawVal.replace(/[$,]/g, ''));
                env[varName] = isNaN(num) ? "$0.00" : "$" + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            } else if (line.startsWith('$fetch ')) {
                const parts = line.slice(7).split(' ');
                const k = parts[0];
                if (RESERVED_VARIABLES.has(k) || FORBIDDEN_KEYS.has(k)) throw new Error(`Assignment rejected: ${k} is a reserved system variable.`);
                const rawUrl = await resolve(parts.slice(1).join(' '));
                try {
                    const parsedUrl = new URL(rawUrl);
                    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error("Invalid transfer protocol (HTTP/HTTPS only).");
                    const resolvedIp = await lookupIp(parsedUrl.hostname);
                    if (!resolvedIp || isPrivateOrLocalIp(resolvedIp)) throw new Error("Destination IP address resolved to a private range.");
                    const response = await axios.get(parsedUrl.href, { timeout: FETCH_TIMEOUT_MS, maxContentLength: MAX_RESPONSE_SIZE_BYTES, responseType: 'text', headers: { 'User-Agent': 'MochaBot-Myntax/2.0' } });
                    env[k] = typeof response.data === 'object' ? JSON.stringify(response.data) : String(response.data);
                } catch (fetchErr) { env[k] = '{}'; }
            } else if (line.startsWith('$say ')) {
                const rawSay = await resolve(line.slice(5).replace(/^["'](.*)["']$/, '$1'));
                const formattedSay = rawSay.replace(/\[nl\]/gi, '\n');
                const safeSay = formattedSay.length > MAX_DISCORD_MSG_LENGTH ? formattedSay.slice(0, MAX_DISCORD_MSG_LENGTH) + '...' : formattedSay;
                await msg.reply(safeSay);
            } else if (line.startsWith('$embed ')) {
                const rawEmbed = await resolve(line.slice(7).trim());
                const parts = rawEmbed.split(' | ');
                const embed = new EmbedBuilder();
                for (const part of parts) {
                    const colonIndex = part.indexOf(':');
                    if (colonIndex === -1) continue;
                    const key = part.slice(0, colonIndex).trim().toLowerCase();
                    const val = part.slice(colonIndex + 1).trim();
                    if (!val) continue;
                    if (key === 'title') embed.setTitle(val);
                    else if (key === 'desc' || key === 'description') embed.setDescription(val.replace(/\[nl\]/gi, '\n'));
                    else if (key === 'color') embed.setColor(parseInt(val.startsWith('#') ? val.replace('#', '0x') : val) || 0x000000);
                    else if (key === 'footer') embed.setFooter({ text: val });
                    else if (key === 'thumbnail') embed.setThumbnail(val);
                    else if (key === 'image') embed.setImage(val);
                    else if (key === 'author') embed.setAuthor({ name: val });
                }
                await msg.reply({ embeds: [embed] });
            } else if (line.startsWith('$math ')) {
                const expr = await resolve(line.slice(6));
                try {
                    const mathResult = parseAndEvaluate(expr, user, target, localVars, serverVars, env, settings);
                    env.math = String(mathResult !== null ? mathResult : 0);
                } catch { env.math = "0"; }
            }
        } catch (e) {
            if (!suppressErrors) await msg.reply(`❌ Custom logic failed: ${e.message}`);
        }
    }
}

module.exports = { runMyntax };
