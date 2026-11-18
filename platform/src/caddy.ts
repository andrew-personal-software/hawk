/** The same site file caddy/setup.sh writes, pointed at one slot. */
export const renderSite = (app: string, domain: string, port: number): string =>
  `${app}.${domain} {\n\timport tailnet\n\treverse_proxy 127.0.0.1:${port}\n}`
