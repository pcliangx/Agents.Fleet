export interface DesktopApi {
  getConnectionInfo(): Promise<string>;
}

export const createDesktopApi = (getConnectionInfo: () => Promise<string>): DesktopApi => ({
  getConnectionInfo,
});
