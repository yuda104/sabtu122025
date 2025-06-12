import { request, HTTP_GET } from './request.js';

const objectPool = (() => {
    /**
     * @type {Map<string, Promise<Cache>>|null}
     */
    let cachePool = null;

    return {
        /**
         * @param {string} name
         * @returns {Promise<Cache>}
         */
        getInstance: (name) => {
            if (!cachePool) {
                cachePool = new Map();
            }

            if (!cachePool.has(name)) {
                cachePool.set(name, window.caches.open(name));
            }

            return cachePool.get(name);
        },
    };
})();

export const cache = (cacheName) => {

    /**
     * @type {Map<string, string>}
     */
    const objectUrls = new Map();

    /**
     * @type {Map<string, Promise<string>>}
     */
    const inFlightRequests = new Map();

    /**
     * @type {caches|null}
     */
    let cacheObject = null;

    let ttl = 1000 * 60 * 60 * 6;

    /**
     * @returns {Promise<void>}
     */
    const open = async () => {
        if (!cacheObject && window.isSecureContext) {
            cacheObject = await objectPool.getInstance(cacheName);
        }
    };

    /**
     * @param {string} input
     * @param {Promise<void>|null} [cancel=null]
     * @returns {Promise<string>}
     */
    const get = (input, cancel = null) => {
        if (objectUrls.has(input)) {
            return Promise.resolve(objectUrls.get(input));
        }

        if (inFlightRequests.has(input)) {
            return inFlightRequests.get(input);
        }

        const inflightPromise = open().then(() => {

            /**
             * @returns {Promise<Blob>}
             */
            const fetchPut = () => request(HTTP_GET, input)
                .withCancel(cancel)
                .withRetry()
                .default()
                .then((r) => r.blob().then((b) => {
                    if (!r.ok) {
                        throw new Error(r.statusText);
                    }

                    if (!window.isSecureContext) {
                        return b;
                    }

                    const headers = new Headers(r.headers);
                    const expiresDate = new Date(Date.now() + ttl);

                    return b.arrayBuffer().then((ab) => {
                        headers.set('Expires', expiresDate.toUTCString());
                        headers.set('Content-Length', String(ab.byteLength));

                        return cacheObject.put(input, new Response(ab, { headers })).then(() => b);
                    });
                }));

            /**
             * @param {Blob} b 
             * @returns {string}
             */
            const blobToUrl = (b) => {
                objectUrls.set(input, URL.createObjectURL(b));
                return objectUrls.get(input);
            };

            if (!window.isSecureContext) {
                return fetchPut().then((b) => blobToUrl(b));
            }

            return cacheObject.match(input).then((res) => {
                if (!res) {
                    return fetchPut();
                }

                const expiresHeader = res.headers.get('Expires');
                const expiresTime = expiresHeader ? (new Date(expiresHeader)).getTime() : 0;

                if (Date.now() > expiresTime) {
                    return cacheObject.delete(input).then((s) => s ? fetchPut() : res.blob());
                }

                return res.blob();
            }).then((b) => blobToUrl(b));
        }).finally(() => {
            inFlightRequests.delete(input);
        });

        inFlightRequests.set(input, inflightPromise);
        return inflightPromise;
    };

    /**
     * @param {object[]} items
     * @param {Promise<void>|null} cancel
     * @returns {Promise<void>}
     */
    const run = async (items, cancel = null) => {
        await open();
        const uniq = new Map();

        if (!window.isSecureContext) {
            console.warn('Cache is not supported in insecure context');
        }

        items.filter((val) => val !== null).forEach((val) => {
            const exist = uniq.get(val.url) ?? [];
            uniq.set(val.url, [...exist, [val.res, val?.rej]]);
        });

        return Promise.allSettled(Array.from(uniq).map(([k, v]) => get(k, cancel)
            .then((s) => {
                v.forEach((cb) => cb[0]?.(s));
                return s;
            })
            .catch((r) => {
                v.forEach((cb) => cb[1]?.(r));
                return r;
            })
        ));
    };

    /**
     * @param {string} input
     * @param {string} name
     * @returns {Promise<Response>}
     */
    const download = async (input, name) => {
        const reverse = new Map(Array.from(objectUrls.entries()).map(([k, v]) => [v, k]));

        if (!reverse.has(input)) {
            try {
                const checkUrl = new URL(input);
                if (!checkUrl.protocol.includes('blob')) {
                    throw new Error('Is not blob');
                }
            } catch {
                input = await get(input);
            }
        }

        return request(HTTP_GET, input).withDownload(name).default();
    };

    return {
        run,
        get,
        open,
        download,
        /**
         * @param {number} v
         * @returns {this} 
         */
        setTtl(v) {
            ttl = Number(v);
            return this;
        },
    };
};