export const HTTP_GET = 'GET';
export const HTTP_PUT = 'PUT';
export const HTTP_POST = 'POST';
export const HTTP_PATCH = 'PATCH';
export const HTTP_DELETE = 'DELETE';

export const HTTP_STATUS_OK = 200;
export const HTTP_STATUS_CREATED = 201;
export const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;

export const ERROR_ABORT = 'AbortError';

export const defaultJSON = {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
};

const singleton = (() => {
    /**
     * @type {Promise<Cache>|null}
     */
    let instance = null;

    return {
        /**
         * @returns {Promise<Cache>}
         */
        getInstance: () => {
            if (!instance) {
                instance = window.caches.open('request');
            }

            return instance;
        },
    };
})();

export const request = (method, path) => {

    const ac = new AbortController();
    const req = {
        signal: ac.signal,
        headers: new Headers(defaultJSON),
        method: String(method).toUpperCase(),
    };

    window.addEventListener('offline', () => ac.abort(), { once: true });
    window.addEventListener('popstate', () => ac.abort(), { once: true });

    let reqTtl = 0;
    let reqRetry = 0;
    let reqDelay = 0;
    let reqAttempts = 0;

    /**
     * @type {string|null}
     */
    let downExt = null;

    /**
    * @type {string|null}
    */
    let downName = null;

    /**
    * @type {function|null}
    */
    let callbackFunc = null;

    /**
     * @param {string|URL} input 
     * @returns {Promise<Response>}
     */
    const baseFetch = (input) => {

        /**
         * @returns {Promise<Response>}
         */
        const abstractFetch = () => {

            /**
             * @returns {Promise<Response>}
             */
            const wrapperFetch = () => window.fetch(input, req).then(async (res) => {
                if (!res.ok || !callbackFunc) {
                    return res;
                }

                const contentLength = parseInt(res.headers.get('Content-Length') ?? '0');
                if (contentLength === 0) {
                    return res;
                }

                const chunks = [];
                let receivedLength = 0;
                const reader = res.body.getReader();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    chunks.push(value);
                    receivedLength += value.length;

                    callbackFunc(receivedLength, contentLength);
                }

                const contentType = res.headers.get('Content-Type') ?? 'application/octet-stream';
                return new Response(new Blob(chunks, { type: contentType }), {
                    status: res.status,
                    statusText: res.statusText,
                    headers: new Headers(res.headers),
                });
            });

            if (reqTtl === 0 || !window.isSecureContext) {
                return wrapperFetch();
            }

            if (req.method !== HTTP_GET) {
                console.warn('Only method GET can be cached');
                return wrapperFetch();
            }

            /**
             * @param {Cache} c 
             * @returns {Promise<Response>}
             */
            const fetchPut = (c) => wrapperFetch().then((res) => {
                if (!res.ok) {
                    return res;
                }

                const cRes = res.clone();
                const headers = new Headers(res.headers);

                return res.clone().arrayBuffer().then((a) => {

                    if (!headers.has('Expires')) {
                        const exp = new Date(Date.now() + reqTtl);
                        headers.set('Expires', exp.toUTCString());
                    }

                    if (!headers.has('Content-Length')) {
                        headers.set('Content-Length', String(a.byteLength));
                    }

                    return c.put(input, new Response(res.body, { headers })).then(() => cRes);
                });
            });

            return singleton.getInstance().then((c) => c.match(input).then((res) => {
                if (!res) {
                    return fetchPut(c);
                }

                const exp = res.headers.get('Expires');
                const expTime = exp ? (new Date(exp)).getTime() : 0;

                if (Date.now() > expTime) {
                    return c.delete(input).then((s) => s ? fetchPut(c) : res);
                }

                return res;
            }));
        };

        if (reqRetry === 0 && reqDelay === 0) {
            return abstractFetch();
        }

        /**
         * @returns {Promise<Response>}
         */
        const attempt = async () => {
            try {
                return await abstractFetch();
            } catch (error) {
                if (error.name === ERROR_ABORT) {
                    throw error;
                }

                reqDelay *= 2;
                reqAttempts++;

                if (reqAttempts > reqRetry) {
                    throw new Error(`Max retries reached: ${error}`);
                }

                console.warn(`Retrying fetch (${reqAttempts}/${reqRetry}): ${input.toString()}`);
                await new Promise((resolve) => window.setTimeout(resolve, reqDelay));

                return attempt();
            }
        };

        return attempt();
    };

    /**
     * @param {Response} res 
     * @returns {Response}
     */
    const baseDownload = (res) => {
        if (res.status !== HTTP_STATUS_OK) {
            return res;
        }

        const exist = document.querySelector('a[download]');
        if (exist) {
            document.body.removeChild(exist);
        }

        const filename = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1];

        return res.clone().blob().then((b) => {
            const link = document.createElement('a');
            const href = window.URL.createObjectURL(b);

            link.href = href;
            link.download = filename ? filename : `${downName}.${downExt ? downExt : (b.type.split('/')?.[1] ?? 'bin')}`;

            document.body.appendChild(link);

            link.click();

            document.body.removeChild(link);
            window.URL.revokeObjectURL(href);

            return res;
        });
    };

    return {
        /**
         * @template T
         * @param {((data: any) => T)=} transform
         * @returns {Promise<{code: number, data: T, error: string[]|null}>}
         */
        send(transform = null) {
            if (downName) {
                Object.keys(defaultJSON).forEach((k) => req.headers.delete(k));
            }

            return baseFetch(new URL(path, document.body.getAttribute('data-url'))).then((res) => {
                if (downName && res.ok) {
                    return {
                        code: res.status,
                        data: baseDownload(res),
                        error: null,
                    };
                }

                return res.json().then((json) => {
                    if (json.error) {
                        const msg = json.error.at(0);
                        const isErrServer = res.status >= HTTP_STATUS_INTERNAL_SERVER_ERROR;
                        throw new Error(isErrServer ? `id: ${json.id}\n${msg}` : msg);
                    }

                    if (transform) {
                        json.data = transform(json.data);
                    }

                    return Object.assign(json, { code: res.status });
                });
            }).catch((err) => {
                if (err.name === ERROR_ABORT) {
                    console.warn('Fetch abort:', err);
                    return err;
                }

                alert(err);
                throw new Error(err);
            });
        },
        /**
         * @param {number} [ttl=21600000]
         * @returns {ReturnType<typeof request>}
         */
        withCache(ttl = 1000 * 60 * 60 * 6) {
            reqTtl = ttl;

            return this;
        },
        /**
         * @param {number} [maxRetries=3]
         * @param {number} [delay=1000]
         * @returns {ReturnType<typeof request>}
         */
        withRetry(maxRetries = 3, delay = 1000) {
            reqRetry = maxRetries;
            reqDelay = delay;

            return this;
        },
        /**
         * @param {Promise<void>|null} cancel
         * @returns {ReturnType<typeof request>}
         */
        withCancel(cancel) {
            if (cancel === null || cancel === undefined) {
                return this;
            }

            (async () => {
                await cancel;
                ac.abort();
            })();

            return this;
        },
        /**
         * @param {string} name 
         * @param {string|null} ext
         * @returns {ReturnType<typeof request>}
         */
        withDownload(name, ext = null) {
            downName = name;
            downExt = ext;
            return this;
        },
        /**
         * @param {function|null} [func=null]
         * @returns {ReturnType<typeof request>}
         */
        withProgressFunc(func = null) {
            callbackFunc = func;
            return this;
        },
        /**
         * @param {object|null} header 
         * @returns {Promise<Response>}
         */
        default(header = null) {
            req.headers = new Headers(header ?? {});
            return baseFetch(path).then((res) => downName ? baseDownload(res) : res);
        },
        /**
         * @param {string} token
         * @returns {ReturnType<typeof request>}
         */
        token(token) {
            if (token.split('.').length === 3) {
                req.headers.append('Authorization', 'Bearer ' + token);
                return this;
            }

            req.headers.append('x-access-key', token);
            return this;
        },
        /**
         * @param {object} body
         * @returns {ReturnType<typeof request>}
         */
        body(body) {
            if (req.method === HTTP_GET) {
                throw new Error('GET method does not support body');
            }

            req.body = JSON.stringify(body);
            return this;
        },
    };
};
