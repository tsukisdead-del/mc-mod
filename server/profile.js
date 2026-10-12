import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Builds an Apple configuration profile (.mobileconfig) containing a Web Clip:
// installing it puts the app on the iPhone Home Screen, full screen, with its own icon.

const xml = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

// Stable UUIDs (derived from the URL) so reinstalling replaces the old profile instead of duplicating it.
function stableUuid(seed) {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  const v = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

export function buildMobileConfig({ url, label, iconPath }) {
  const appUrl = url.replace(/\/+$/, '') + '/';
  const host = new URL(appUrl).host;
  const icon = fs.readFileSync(iconPath).toString('base64').replace(/(.{68})/g, '$1\n\t\t\t');
  const profileUuid = stableUuid(`profile:${appUrl}`);
  const clipUuid = stableUuid(`webclip:${appUrl}`);
  const idBase = `app.mochi.therapy.${host.replace(/[^a-zA-Z0-9]/g, '-')}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>FullScreen</key>
			<true/>
			<key>Icon</key>
			<data>
			${icon}
			</data>
			<key>IsRemovable</key>
			<true/>
			<key>Label</key>
			<string>${xml(label)}</string>
			<key>PayloadDescription</key>
			<string>Adds ${xml(label)} to your Home Screen as a full-screen app.</string>
			<key>PayloadDisplayName</key>
			<string>${xml(label)} (Home Screen app)</string>
			<key>PayloadIdentifier</key>
			<string>${idBase}.webclip</string>
			<key>PayloadType</key>
			<string>com.apple.webClip.managed</string>
			<key>PayloadUUID</key>
			<string>${clipUuid}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>Precomposed</key>
			<true/>
			<key>URL</key>
			<string>${xml(appUrl)}</string>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Installs ${xml(label)}, your AI therapist texting app, on your Home Screen. It only adds an app icon; it doesn't manage or monitor your phone. Remove it any time in Settings › General › VPN &amp; Device Management.</string>
	<key>PayloadDisplayName</key>
	<string>${xml(label)}</string>
	<key>PayloadIdentifier</key>
	<string>${idBase}</string>
	<key>PayloadOrganization</key>
	<string>${xml(label)}</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${profileUuid}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
}

export function defaultIconPath(publicDir) {
  return path.join(publicDir, 'icons', 'apple-touch-icon.png');
}
