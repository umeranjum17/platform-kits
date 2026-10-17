// Generic platform demo: overlay, focused field, screen frames and status-bar chip.
import { useEffect, useRef, useState } from 'react';
import { Dimensions, PermissionsAndroid, PixelRatio, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputInstance } from 'react-native';
import { overlay, stateWords, type OverlayState } from '@platform-kits/overlay';
import { focusedField, type FocusedText } from '@platform-kits/overlay/focused-field';
import { xLength } from '@platform-kits/social';
import { StatusBar } from 'expo-status-bar';
import { stateWords as chipWords, status as chip } from '@platform-kits/statusbar';
import { ScreenDemo } from './ScreenDemo.tsx';
// The example's own name and package: the launcher label, the bubble notice and the panel all say Umer.
const NAME = 'Umer';
const OWN_APP = 'io.github.umeranjum17.byokit.example';
// The field reading the tap handler takes before it opens the panel: the panel's own window would take the field's
// focus, so the bubble reads at the tap and the panel shows that frozen reading.
let panelField: FocusedText | null = null;
// The app's accessibility service can sit between unbind and rebind while a panel opens, so one sample can read off;
// settle on a stable answer, and treat any on sample as on (a service that is truly off stays off).
async function serviceOn(): Promise<boolean> {
  for (let i = 0; i < 10; i += 1) {
    if (await focusedField.available()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
// The draft "Put it in the field" hands over as it closes the panel: with the panel on top nothing holds input
// focus, so the app inserts after the close, when focus is back on the field, and says so on the pill.
let panelDraft: string | null = null;
// Insert after the panel closes: wait for focus to return to the field (it does on close), then put the whole draft
// over all of it. The kit sends nothing; the person still taps send in the app themselves.
async function insertAfterClose(draft: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      if (await focusedField.read()) break;
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  let result = 'failed';
  try {
    result = await focusedField.insert(draft, { replace: 'all', attempts: 13, retryMs: 150 });
  } catch {
    result = 'failed';
  }
  // Confirm from the field itself: the insert can report 'cancelled' when the service rebinds after its set already
  // landed, so the pill only claims what the field shows.
  let landed = result === 'inserted' || result === 'landedWithoutNewlines';
  if (!landed) {
    try {
      landed = (await focusedField.read())?.text === draft;
    } catch {
      landed = false;
    }
  }
  overlay.say(landed ? 'Inserted. Send it yourself.' : `Not inserted (${result}).`, undefined, 60000);
}
function Button({ id, label, onPress }: { id: string; label: string; onPress: () => void }) {
  return <Pressable testID={id} accessibilityRole="button" onPress={onPress} style={s.button}><Text style={s.buttonText}>{label}</Text></Pressable>;
}
/**
 * The bubble over other apps (Android): Start/Stop, and a tap opens the panel registered in index.ts. The tap log, and
 * the focused field once the example's accessibility service (modules/a11y-demo) is on: a long press on the bubble
 * reads it in any app.
 */
function Bubble() {
  const [state, setState] = useState<OverlayState>('off');
  const [taps, setTaps] = useState('');
  const [typed, setTyped] = useState('');
  const [field, setField] = useState('');
  const input = useRef<TextInputInstance>(null);
  const [clear, setClear] = useState('');
  const [dismissed, setDismissed] = useState('');
  useEffect(() => {
    overlay.state().then(setState);
    const offState = overlay.on('state', (e) => setState(e.state));
    // The tap reads the focused field while the bubble still has it, then opens the panel itself (manualPanel), so
    // the panel's own window never takes the focus before the read finishes.
    const offTap = overlay.on('tap', async () => {
      overlay.logTap({ app: OWN_APP, action: 'tap' });
      try {
        panelField = await focusedField.read();
      } catch {
        panelField = null;
      }
      try {
        await overlay.openPanel();
      } catch {
        panelField = null;
      }
    });
    const offPanel = overlay.on('panel', (e) => {
      if (!e.open) {
        panelField = null;
        if (panelDraft != null) {
          const draft = panelDraft;
          panelDraft = null;
          void insertAfterClose(draft);
        }
      }
    });
    // A long press reads the field in focus, in any app: the bubble's window never takes the focus.
    const offLong = overlay.on('longPress', async () => {
      const read = await focusedField.read();
      setField(`available: ${await focusedField.available()}, read: ${JSON.stringify(read)}`);
      overlay.say(read ? `Read: ${read.text}` : 'No text field in focus.');
    });
    const offClear = overlay.on('keepClear', (e) => setClear(e.clear ? 'The bubble is clear of the field.' : 'No clear spot: the bubble stays put.'));
    const offDismissed = overlay.on('dismissed', () => setDismissed('Bubble dismissed. Start it again to bring it back.'));
    return () => { offState(); offTap(); offPanel(); offLong(); offClear(); offDismissed(); };
  }, []);
  const start = async () => {
    setDismissed('');
    const s = await overlay.start({
      host: 'window', mood: 'bubble', panel: 'bubblePanel', manualPanel: true,
      notice: { channel: 'bubble', title: NAME, text: 'The bubble is on.', icon: 'byokit_notification' },
    });
    if (s === 'needs-permission') await overlay.openPermission();
  };
  // The field's box in full-display pixels (the window is edge to edge), then a pill that would otherwise cover it.
  const keepFieldClear = () => input.current?.measureInWindow((x, y, width, height) => {
    const d = PixelRatio.get();
    const box = { left: x * d, top: y * d, width: width * d, height: height * d };
    overlay.keepClear([box]);
    overlay.say('Inserted. Send it yourself.', undefined, 60000);
    setClear(`Keeping clear of ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}×${Math.round(box.height)}.`);
  });
  return (
    <View style={s.sheet}>
      <Text testID="bubble" style={s.words}>{stateWords(state)}</Text>
      {state === 'on' ? <Button id="bubbleStop" label="Stop the bubble" onPress={() => overlay.stop()} />
        : <Button id="bubbleStart" label="Start the bubble" onPress={start} />}
      <Button id="taps" label="Show the taps" onPress={async () => setTaps(JSON.stringify(await overlay.taps()))} />
      {!!taps && <Text testID="tapLog" style={s.small}>{taps}</Text>}
      <Button id="fieldRead" label="Read the focused field" onPress={async () => {
        setField(`available: ${await focusedField.available()}, read: ${JSON.stringify(await focusedField.read())}`);
      }} />
      {!!field && <Text testID="field" style={s.small}>{field}</Text>}
      <TextInput ref={input} testID="fieldInput" value={typed} onChangeText={setTyped} placeholder="Type here, then read it (above)" style={s.input} />
      <Button id="sayPill" label="Show the pill" onPress={() => overlay.say('Inserted. Send it yourself.', undefined, 60000)} />
      <Button id="keepClear" label="Keep the field clear" onPress={keepFieldClear} />
      <Button id="keepClearAll" label="Keep the whole screen clear" onPress={() => {
        // No clear spot anywhere: the bubble stays at its own spot and the keepClear event says so.
        const { width, height } = Dimensions.get('screen');
        overlay.keepClear([{ left: 0, top: 0, width: width * PixelRatio.get(), height: height * PixelRatio.get() }]);
      }} />
      <Button id="keepClearOff" label="Stop keeping it clear" onPress={() => { overlay.keepClear([]); setClear('Back at its own spot.'); }} />
      {!!clear && <Text testID="clear" style={s.small}>{clear}</Text>}
      {!!dismissed && <Text testID="bubbleDismissed" style={s.small}>{dismissed}</Text>}
    </View>
  );
}

// The host-supplied drafter for this demo: a small local function, no provider SDK and no network. A real host
// plugs in a drafter backed by BYOKit accounts.
async function demoDrafter(text: string): Promise<string> {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed ? `Polished: ${trimmed}` : '';
}

/**
 * The panel a bubble tap opens, in its own translucent activity: the field the bubble last read in focus, shown in
 * full and wrapped. The kit returns the app's package; the example's own field reads as its name. Nothing focused,
 * or no accessibility service, is said plainly instead of pretending a read happened.
 *
 * Assist mode ("Help me write" → "Put it in the field"): the demo drafter above writes a draft from the frozen
 * reading, the draft shows with its X length check, and "Put it in the field" closes the panel and inserts the
 * draft into the field once its focus returns (the panel on top leaves nothing focused to insert into).
 * The kit sends nothing: no Social.post/approve call, no network; the person still taps send in the app themselves.
 * A password field reads as null, and there is no copy fallback for it.
 */
export function BubblePanel() {
  const [read, setRead] = useState<FocusedText | null>(null);
  const [reading, setReading] = useState(true);
  const [service, setService] = useState(true);
  const [draft, setDraft] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      const available = await serviceOn();
      if (!live) return;
      setService(available);
      setRead(panelField);
      setReading(false);
    })();
    return () => { live = false; };
  }, []);
  const app = read ? (read.app === OWN_APP ? NAME : read.app) : '';
  const help = async () => {
    if (!read || drafting) return;
    setDrafting(true);
    try {
      setDraft(await demoDrafter(read.text));
    } finally {
      setDrafting(false);
    }
  };
  const put = async () => {
    if (draft == null) return;
    // The panel's window holds the screen, so nothing underneath has input focus for an insert. Hand the draft over,
    // close the panel, and let the app insert once focus is back on the field (see insertAfterClose).
    panelDraft = draft;
    try {
      await overlay.closePanel();
    } catch {
      panelDraft = null;
    }
  };
  const over = draft == null ? 0 : xLength(draft) - 280;
  return (
    <View style={s.panel}>
      <View testID="panel" style={s.panelCard}>
        <Text style={s.panelTitle}>{NAME}</Text>
        {reading ? <Text style={s.small}>Reading the field…</Text>
          : read ? (
            <View style={s.panelBody}>
              <Text testID="panelApp" style={s.small}>In focus: {app}</Text>
              <ScrollView testID="panelScroll" style={s.panelScroll} contentContainerStyle={s.panelScrollWords}>
                <Text testID="panelText" style={s.panelText}>{read.text}</Text>
              </ScrollView>
              <Button id="assistHelp" label="Help me write" onPress={help} />
              {drafting && <Text style={s.small}>Writing a draft…</Text>}
              {draft != null && (
                <View style={s.panelBody}>
                  <ScrollView style={s.panelScroll} contentContainerStyle={s.panelScrollWords}>
                    <Text testID="assistDraft" style={s.panelText}>{draft}</Text>
                  </ScrollView>
                  <Text testID="assistLength" style={s.small}>
                    {over > 0 ? `Too long for X by ${over} (${xLength(draft)} / 280).` : `Fits X (${xLength(draft)} / 280).`}
                  </Text>
                  <Button id="assistInsert" label="Put it in the field" onPress={put} />
                </View>
              )}
            </View>
          ) : (
            <Text testID="panelUnavailable" style={s.small}>
              {service
                ? 'No text field is in focus. Tap a field, then open the bubble again.'
                : 'Umer can’t read fields yet. Turn on Umer’s accessibility service in Settings.'}
            </Text>
          )}
        <Button id="panelClose" label="Close" onPress={() => overlay.closePanel()} />
      </View>
    </View>
  );
}

/** One ongoing job as a status-bar chip (@platform-kits/statusbar): show with three actions, clear, and what came back. */
function Chip() {
  const [said, setSaid] = useState('');
  const [n, setN] = useState(1);
  useEffect(() => {
    const offs = [chip.on('action', (e) => setSaid(`Action: ${e.id}`)), chip.on('dismissed', () => setSaid('Dismissed.'))];
    return () => offs.forEach((off) => off());
  }, []);
  const show = async (busy: number) => {
    if (Platform.OS === 'android') await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS');
    chip.show({
      title: `Scribe and ${busy} more are working`, text: '2 need you', chip: `${busy} busy`, publicText: `${busy} working · 2 need you`,
      icon: 'byokit_notification', promote: true, timeoutMs: 15 * 60_000,
      actions: [{ id: 'needs', label: 'See what needs you' }, { id: 'ask', label: 'Ask Chief' }, { id: 'open', label: 'Open' }],
    });
    setN(busy + 1);
    setSaid(chipWords(await chip.state()));
  };
  return (
    <View style={s.sheet}>
      <Button id="chip-show" label="Show the chip" onPress={() => show(n)} />
      <Button id="chip-clear" label="Clear the chip" onPress={() => { chip.clear(); setN(1); setSaid('Cleared.'); }} />
      {!!said && <Text testID="chip-said" style={s.small}>{said}</Text>}
    </View>
  );
}

export default function App() {
  return process.env.EXPO_PUBLIC_SCREEN_DEMO === '1' ? <ScreenDemo /> :
    <SafeAreaView style={{ flex: 1 }}><StatusBar style="dark" /><ScrollView contentContainerStyle={s.screen}>
      <Text style={s.title}>Umer</Text><Bubble /><Chip />
    </ScrollView></SafeAreaView>;
}
const s = StyleSheet.create({
  screen: { backgroundColor: '#fff', padding: 24, paddingTop: 64, gap: 12 },
  input: { fontSize: 17, borderWidth: 1, borderColor: '#bbb', borderRadius: 8, padding: 10, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '600' },
  words: { fontSize: 18 },
  small: { fontSize: 14, color: '#555' },
  code: { fontSize: 32, fontWeight: '700', letterSpacing: 2 },
  sheet: { gap: 12, padding: 16, borderRadius: 12, backgroundColor: '#f2f2f2' },
  panel: { flex: 1, justifyContent: 'flex-end', padding: 16 },
  panelCard: { gap: 12, padding: 16, borderRadius: 12, backgroundColor: '#f2f2f2', maxHeight: '85%' },
  panelTitle: { fontSize: 20, fontWeight: '600' },
  panelBody: { flexShrink: 1, gap: 8 },
  panelScroll: { flexShrink: 1 },
  panelScrollWords: { paddingBottom: 4 },
  panelText: { fontSize: 17, lineHeight: 24 },
  button: { backgroundColor: '#111', borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 17 },
});
