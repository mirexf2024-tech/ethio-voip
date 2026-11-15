from pathlib import Path
import re
p = Path('android/app/src/main/AndroidManifest.xml')
if not p.exists():
    raise SystemExit('Generated AndroidManifest.xml not found')
s = p.read_text()
permissions = [
    'android.permission.INTERNET',
    'android.permission.RECORD_AUDIO',
    'android.permission.CAMERA',
    'android.permission.MODIFY_AUDIO_SETTINGS',
    'android.permission.POST_NOTIFICATIONS',
]
for permission in permissions:
    tag = f'<uses-permission android:name="{permission}" />'
    if tag not in s:
        s = re.sub(r'(<manifest\b[^>]*>)', r'\1\n    ' + tag, s, count=1)
features = [
    'android.hardware.microphone',
    'android.hardware.camera',
]
for feature in features:
    tag = f'<uses-feature android:name="{feature}" android:required="false" />'
    if tag not in s:
        s = re.sub(r'(<manifest\b[^>]*>)', r'\1\n    ' + tag, s, count=1)
p.write_text(s)
print('Android media/network permissions merged.')
