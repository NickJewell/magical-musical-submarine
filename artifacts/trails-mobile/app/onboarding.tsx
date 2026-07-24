import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  getGetNextPairQueryOptions,
  getSearchMusicQueryOptions,
  useAddSeed,
  useGeneratePortrait,
  useSubmitPair,
} from '@workspace/api-client-react';
import type { SearchResult } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useUser } from '@/context/UserContext';

type Phase = 'seeds' | 'pairs' | 'portrait';

const MIN_SEEDS = 5;

export default function OnboardingScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { userId, refreshState } = useUser();

  const [phase, setPhase] = useState<Phase>('seeds');
  const [seedCount, setSeedCount] = useState(0);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [addedMbids, setAddedMbids] = useState<Set<string>>(new Set());
  const [portraitText, setPortraitText] = useState('');

  const addSeed = useAddSeed();
  const submitPair = useSubmitPair();
  const generatePortrait = useGeneratePortrait();
  const [addSeedError, setAddSeedError] = useState<string | null>(null);

  // Debounce search
  const [searchTimer, setSearchTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleQueryChange = (text: string) => {
    setQuery(text);
    if (searchTimer) clearTimeout(searchTimer);
    const t = setTimeout(() => setDebouncedQuery(text), 400);
    setSearchTimer(t);
  };

  const searchResults = useQuery({
    ...getSearchMusicQueryOptions({
      q: debouncedQuery,
      userId: userId ?? 0,
      type: 'track',
    }),
    enabled: debouncedQuery.length >= 2 && !!userId,
    retry: false,
  });

  const nextPair = useQuery({
    ...getGetNextPairQueryOptions({ userId: userId ?? 0 }),
    enabled: phase === 'pairs' && !!userId,
  });

  const handleAddSeed = async (result: SearchResult) => {
    if (!userId || addedMbids.has(result.mbid)) return;
    setAddSeedError(null);
    try {
      await addSeed.mutateAsync({
        data: {
          userId,
          mbid: result.mbid,
          type: result.type === 'album' ? 'album' : 'track',
          title: result.title,
          artist: result.artist,
          year: result.year,
        },
      });
      setAddedMbids((s) => new Set(s).add(result.mbid));
      const next = seedCount + 1;
      setSeedCount(next);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      setAddSeedError("Couldn't save track, please try again");
    }
  };

  const handleSubmitPair = async (result: number) => {
    if (!userId || !nextPair.data || nextPair.data.done) return;
    const { aMbid, bMbid } = nextPair.data;
    if (!aMbid || !bMbid) return;
    try {
      await submitPair.mutateAsync({ data: { userId, aMbid, bMbid, result } });
      Haptics.selectionAsync();
      nextPair.refetch();
    } catch {
      // ignore
    }
  };

  const handleGeneratePortrait = async () => {
    if (!userId) return;
    try {
      const portrait = await generatePortrait.mutateAsync({ data: { userId } });
      setPortraitText(portrait.text);
      await refreshState();
    } catch {
      setPortraitText('');
    }
  };

  const handleFinish = () => {
    refreshState();
    router.replace('/(tabs)');
  };

  const topPad = Platform.OS === 'web' ? 67 : insets.top + 16;
  const botPad = Platform.OS === 'web' ? 34 : insets.bottom + 24;

  // ── Phase: Seeds ──────────────────────────────────────────────────────────
  if (phase === 'seeds') {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { paddingTop: topPad }]}>
          <Text style={[styles.step, { color: colors.mutedForeground }]}>
            step 1 of 3
          </Text>
          <Text style={[styles.title, { color: colors.foreground }]}>
            seed your taste
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            add music you love — at least {MIN_SEEDS} tracks or albums
          </Text>

          <View
            style={[
              styles.progressBar,
              { backgroundColor: colors.border, borderRadius: 4 },
            ]}
          >
            <View
              style={[
                styles.progressFill,
                {
                  backgroundColor: colors.primary,
                  width: `${Math.min((seedCount / MIN_SEEDS) * 100, 100)}%`,
                  borderRadius: 4,
                },
              ]}
            />
          </View>
          <Text style={[styles.counter, { color: colors.mutedForeground }]}>
            {seedCount} / {MIN_SEEDS}
          </Text>

          <TextInput
            value={query}
            onChangeText={handleQueryChange}
            placeholder="search for a track or album…"
            placeholderTextColor={colors.mutedForeground}
            style={[
              styles.searchInput,
              {
                color: colors.foreground,
                backgroundColor: colors.card,
                borderColor: colors.border,
                borderRadius: colors.radius,
                fontFamily: 'Inter_400Regular',
              },
            ]}
          />
        </View>

        {addSeedError && (
          <View style={{ paddingHorizontal: 24, paddingBottom: 4 }}>
            <Text style={{ color: colors.destructive ?? '#ef4444', fontSize: 14, textAlign: 'center' }}>
              {addSeedError}
            </Text>
          </View>
        )}

        {searchResults.isError ? (
          <View style={styles.center}>
            <Text style={{ color: colors.destructive ?? '#ef4444', fontSize: 14, textAlign: 'center' }}>
              Search timed out, please try again.
            </Text>
          </View>
        ) : searchResults.isFetching ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : (
          <FlatList
            data={searchResults.data ?? []}
            keyExtractor={(item) => item.mbid}
            contentContainerStyle={{ paddingBottom: botPad + 80 }}
            ListEmptyComponent={
              debouncedQuery.length >= 2 && !searchResults.isFetching ? (
                <View style={styles.center}>
                  <Text style={{ color: colors.mutedForeground, fontSize: 14 }}>
                    no results found
                  </Text>
                </View>
              ) : null
            }
            renderItem={({ item }) => {
              const added = addedMbids.has(item.mbid);
              return (
                <TouchableOpacity
                  onPress={() => handleAddSeed(item)}
                  disabled={added}
                  activeOpacity={0.7}
                  style={[
                    styles.resultRow,
                    {
                      backgroundColor: added ? colors.accent : colors.card,
                      borderColor: added ? colors.primary : colors.border,
                      borderRadius: colors.radius,
                    },
                  ]}
                >
                  <View style={styles.resultText}>
                    <Text
                      style={[styles.resultTitle, { color: colors.foreground }]}
                      numberOfLines={1}
                    >
                      {item.title}
                    </Text>
                    <Text
                      style={[
                        styles.resultArtist,
                        { color: colors.mutedForeground },
                      ]}
                      numberOfLines={1}
                    >
                      {item.artist}
                      {item.year ? ` · ${item.year}` : ''}
                    </Text>
                  </View>
                  <Ionicons
                    name={added ? 'checkmark-circle' : 'add-circle-outline'}
                    size={22}
                    color={added ? colors.primary : colors.mutedForeground}
                  />
                </TouchableOpacity>
              );
            }}
          />
        )}

        {seedCount >= MIN_SEEDS && (
          <View
            style={[
              styles.fab,
              { bottom: botPad + 16, backgroundColor: colors.primary, borderRadius: 28 },
            ]}
          >
            <TouchableOpacity
              onPress={() => setPhase('pairs')}
              activeOpacity={0.8}
              style={styles.fabInner}
            >
              <Text
                style={[
                  styles.fabText,
                  { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' },
                ]}
              >
                next →
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  // ── Phase: Pairs ──────────────────────────────────────────────────────────
  if (phase === 'pairs') {
    const pair = nextPair.data;
    const done = pair?.done ?? false;

    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <View
          style={[
            styles.pairsContainer,
            { paddingTop: topPad, paddingBottom: botPad },
          ]}
        >
          <Text style={[styles.step, { color: colors.mutedForeground }]}>
            step 2 of 3
          </Text>
          <Text style={[styles.title, { color: colors.foreground }]}>
            refine your taste
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            which resonates more with you right now?
          </Text>

          {nextPair.isPending ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : done ? (
            <View style={styles.doneContainer}>
              <Ionicons name="checkmark-circle" size={56} color={colors.primary} />
              <Text style={[styles.doneText, { color: colors.foreground }]}>
                taste calibrated
              </Text>
              <TouchableOpacity
                onPress={() => setPhase('portrait')}
                activeOpacity={0.8}
                style={[
                  styles.button,
                  { backgroundColor: colors.primary, borderRadius: colors.radius },
                ]}
              >
                <Text
                  style={[
                    styles.buttonText,
                    { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' },
                  ]}
                >
                  generate portrait
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.pairCards}>
              {pair?.pairIndex != null && pair?.totalPairs != null && (
                <Text style={[styles.pairCounter, { color: colors.mutedForeground }]}>
                  {pair.pairIndex + 1} of {pair.totalPairs}
                </Text>
              )}
              <TouchableOpacity
                onPress={() => handleSubmitPair(-2)}
                disabled={submitPair.isPending}
                activeOpacity={0.8}
                style={[
                  styles.pairCard,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                    borderRadius: colors.radius,
                  },
                ]}
              >
                <Text
                  style={[styles.pairTitle, { color: colors.foreground }]}
                  numberOfLines={2}
                >
                  {pair?.aTitle ?? '—'}
                </Text>
                <Text style={[styles.pairArtist, { color: colors.mutedForeground }]}>
                  {pair?.aArtist ?? ''}
                </Text>
              </TouchableOpacity>

              <Text style={[styles.orText, { color: colors.mutedForeground }]}>or</Text>

              <TouchableOpacity
                onPress={() => handleSubmitPair(2)}
                disabled={submitPair.isPending}
                activeOpacity={0.8}
                style={[
                  styles.pairCard,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                    borderRadius: colors.radius,
                  },
                ]}
              >
                <Text
                  style={[styles.pairTitle, { color: colors.foreground }]}
                  numberOfLines={2}
                >
                  {pair?.bTitle ?? '—'}
                </Text>
                <Text style={[styles.pairArtist, { color: colors.mutedForeground }]}>
                  {pair?.bArtist ?? ''}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => handleSubmitPair(0)}
                disabled={submitPair.isPending}
                activeOpacity={0.7}
                style={styles.tieBtn}
              >
                <Text style={[styles.tieText, { color: colors.mutedForeground }]}>
                  both equally
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    );
  }

  // ── Phase: Portrait ───────────────────────────────────────────────────────
  return (
    <LinearGradient
      colors={[colors.background, '#020508']}
      style={StyleSheet.absoluteFill}
    >
      <View
        style={[
          styles.portraitContainer,
          { paddingTop: topPad, paddingBottom: botPad },
        ]}
      >
        <Text style={[styles.step, { color: colors.mutedForeground }]}>
          step 3 of 3
        </Text>
        <Text style={[styles.title, { color: colors.foreground }]}>
          your portrait
        </Text>

        {generatePortrait.isPending ? (
          <View style={styles.portraitLoading}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>
              composing your musical soul…
            </Text>
          </View>
        ) : portraitText ? (
          <View style={styles.portraitContent}>
            <View
              style={[
                styles.portraitCard,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.accent,
                  borderRadius: colors.radius,
                },
              ]}
            >
              <Text style={[styles.portraitText, { color: colors.foreground }]}>
                {portraitText}
              </Text>
            </View>

            <TouchableOpacity
              onPress={handleFinish}
              activeOpacity={0.8}
              style={[
                styles.button,
                { backgroundColor: colors.primary, borderRadius: colors.radius },
              ]}
            >
              <Text
                style={[
                  styles.buttonText,
                  { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' },
                ]}
              >
                dive in
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.portraitContent}>
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
              we'll weave your seeds and preferences into a musical portrait.
            </Text>
            <TouchableOpacity
              onPress={handleGeneratePortrait}
              activeOpacity={0.8}
              style={[
                styles.button,
                { backgroundColor: colors.primary, borderRadius: colors.radius },
              ]}
            >
              <Text
                style={[
                  styles.buttonText,
                  { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' },
                ]}
              >
                generate portrait
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: 24, gap: 8, paddingBottom: 8 },
  step: { fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  title: { fontSize: 26, fontFamily: 'Inter_700Bold', letterSpacing: -0.5 },
  subtitle: { fontSize: 15, lineHeight: 22 },
  progressBar: { height: 4, width: '100%', marginTop: 4 },
  progressFill: { height: '100%' },
  counter: { fontSize: 12 },
  searchInput: {
    height: 48,
    paddingHorizontal: 14,
    fontSize: 15,
    borderWidth: 1,
    marginTop: 4,
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    marginHorizontal: 16,
    marginVertical: 4,
    borderWidth: 1,
  },
  resultText: { flex: 1, marginRight: 8 },
  resultTitle: { fontSize: 15, fontFamily: 'Inter_500Medium' },
  resultArtist: { fontSize: 13, marginTop: 2 },
  fab: {
    position: 'absolute',
    right: 24,
    paddingHorizontal: 24,
    paddingVertical: 14,
    elevation: 4,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  fabInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fabText: { fontSize: 16 },
  pairsContainer: {
    flex: 1,
    paddingHorizontal: 24,
    gap: 16,
  },
  pairCards: { flex: 1, gap: 12 },
  pairCounter: { fontSize: 12, textAlign: 'center' },
  pairCard: {
    flex: 1,
    padding: 20,
    borderWidth: 1,
    justifyContent: 'center',
  },
  pairTitle: { fontSize: 20, fontFamily: 'Inter_600SemiBold', letterSpacing: -0.3 },
  pairArtist: { fontSize: 14, marginTop: 6 },
  orText: { textAlign: 'center', fontSize: 13 },
  tieBtn: { alignSelf: 'center', paddingVertical: 8 },
  tieText: { fontSize: 14 },
  doneContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 20 },
  doneText: { fontSize: 22, fontFamily: 'Inter_600SemiBold' },
  button: {
    height: 52,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  buttonText: { fontSize: 16 },
  portraitContainer: { flex: 1, paddingHorizontal: 24, gap: 16 },
  portraitLoading: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 20 },
  loadingText: { fontSize: 15, textAlign: 'center' },
  portraitContent: { flex: 1, gap: 20 },
  portraitCard: { padding: 20, borderWidth: 1, flex: 1 },
  portraitText: { fontSize: 15, lineHeight: 24 },
});
