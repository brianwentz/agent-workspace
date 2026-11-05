// Which view a reload hit (never its URL): the active Linked Context tab, the
// shell UI, a pooled provider view (Devin Cloud / OpenHands), Analytics, or
// anything else (e.g. a background tab).
export type ReloadView = 'tab' | 'shell' | 'provider' | 'analytics' | 'other';

export function reloadView(is: { tab: boolean; shell: boolean; provider: boolean; analytics: boolean }): ReloadView {
  if (is.tab) return 'tab';
  if (is.shell) return 'shell';
  if (is.provider) return 'provider';
  if (is.analytics) return 'analytics';
  return 'other';
}
