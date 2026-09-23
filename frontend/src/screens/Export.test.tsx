import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The preview screen renders whatever the backend reports. A field rename in
 * the backend response must not silently degrade the UI into `undefined`, so
 * these tests pin the real response shape returned by POST /api/projects/:id/preview.
 */
const previewResponse = {
  available: false,
  status: 'NOT_AVAILABLE',
  devices: [] as string[],
  installed: false,
  launched: false,
  packageName: 'com.myaistudio.hello',
  logcat: [] as string[],
  screenshots: [] as string[],
  message: 'ANDROID PREVIEW: NOT AVAILABLE - adb present but no device/emulator is attached.',
  steps: [{ step: 'adb devices', ok: false, detail: 'no device attached' }],
};

vi.mock('../api/client.ts', () => ({
  api: { preview: vi.fn(async () => ({ preview: previewResponse })) },
  downloadUrl: (p: string) => p,
}));

const { PreviewScreen } = await import('./Export.tsx');

afterEach(cleanup);

describe('PreviewScreen', () => {
  it('renders the real backend message, package and step detail instead of undefined', async () => {
    render(<PreviewScreen projectId="p1" />);

    await waitFor(() => expect(screen.getByText(/NOT AVAILABLE/)).toBeTruthy());
    expect(screen.getByText(previewResponse.message)).toBeTruthy();
    expect(screen.getByText('com.myaistudio.hello')).toBeTruthy();
    expect(screen.getByText('no device attached')).toBeTruthy();
    expect(document.body.textContent).not.toContain('undefined');
  });
});
