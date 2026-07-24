import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  useChooseStep,
  useCreateDive,
  useGetDirections,
  useGetRecommendations,
  useRateRec,
  type DirectionsResponse,
  type Recommendation,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useUser } from '@/context/UserContext';
import DirectionCard from '@/components/DirectionCard';
import RecCard from '@/components/RecCard';

type DivePhase =
  | { tag: 'no-dive' }
  | { tag: 'starting'; name: string }
  | { tag: 'get-directions'; diveId: number }
  | { tag: 'directions'; diveId: number; data: DirectionsResponse }
  | { tag: 'choosing-step'; diveId: number; direction: string; data: DirectionsResponse }
  | { tag: 'get-recs'; stepId: number }
  | { tag: 'recs'; recs: Recommendation[]; diveId: number; stepId: number };

export default function DiveScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { userId, appState, refreshState } = useUser();

  const [phase, setPhase] = useState<DivePhase>(() => {
    if (appState?.activeDiveId) {
      return { tag: 'get-directions', diveId: appState.activeDiveId };
    }
    return { tag: 'no-dive' };
  });
  const [diveName, setDiveName] = useState('');

  const createDive = useCreateDive();
  const getDirections = useGetDirections();
  const chooseStep = useChooseStep();
  const getRecommendations = useGetRecommendations();
  const rateRec = useRateRec();

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const botPad = Platform.OS === 'web' ? 34 : insets.bottom;

  // Whenever appState updates (after navigating here), sync phase if needed
  // Only move from no-dive → get-directions when a dive becomes active
  const effectiveDiveId =
    phase.tag !== 'no-dive' && 'diveId' in phase ? phase.diveId : null;

  const handleStartDive = useCallback(async () => {
    if (!userId) return;
    const name = diveName.trim() || 'untitled dive';
    try {
      const dive = await createDive.mutateAsync({ data: { userId, name } });
      await refreshState();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setPhase({ tag: 'get-directions', diveId: dive.id });
    } catch {
      // ignore
    }
  }, [userId, diveName, createDive, refreshState]);

  const handleGetDirections = useCallback(async (diveId: number) => {
    if (!userId) return;
    try {
      const data = await getDirections.mutateAsync({ data: { userId, diveId } });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setPhase({ tag: 'directions', diveId, data });
    } catch {
      // ignore
    }
  }, [userId, getDirections]);

  const handleChooseDirection = useCallback(async (direction: string, diveId: number, directionsData: DirectionsResponse) => {
    if (!userId) return;
    setPhase({ tag: 'choosing-step', diveId, direction, data: directionsData });
    try {
      const step = await chooseStep.mutateAsync({
        data: {
          userId,
          diveId,
          chosenDirection: direction,
          hypothesisText: directionsData.hypothesis,
          directionsJson: {
            hypothesis: directionsData.hypothesis,
            directions: directionsData.directions,
            wellTroddenDirection: directionsData.wellTroddenDirection,
          },
        },
      });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setPhase({ tag: 'get-recs', stepId: step.id });

      const recs = await getRecommendations.mutateAsync({ data: { stepId: step.id, userId } });
      setPhase({ tag: 'recs', recs, diveId, stepId: step.id });
    } catch {
      setPhase({ tag: 'get-directions', diveId });
    }
  }, [userId, chooseStep, getRecommendations]);

  const handleRate = useCallback(async (
    recId: number,
    listenState: 'listened' | 'skipped' | 'known',
    score?: number | null,
  ) => {
    if (!userId) return;
    try {
      await rateRec.mutateAsync({ data: { userId, recId, listenState, score: score ?? null } });
      Haptics.selectionAsync();
    } catch {
      // ignore
    }
  }, [userId, rateRec]);

  const handleContinue = useCallback((diveId: number) => {
    setPhase({ tag: 'get-directions', diveId });
  }, []);

  const handleNewDive = useCallback(() => {
    setDiveName('');
    setPhase({ tag: 'no-dive' });
  }, []);

  // ── No dive ────────────────────────────────────────────────────────────────
  if (phase.tag === 'no-dive') {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <LinearGradient
          colors={[colors.background, '#020406']}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View
          style={[
            styles.centeredContent,
            { paddingTop: topPad + 24, paddingBottom: botPad + 24 },
          ]}
        >
          {/* Glow orb */}
          <View
            style={[
              styles.glowOrb,
              { backgroundColor: colors.primary, shadowColor: colors.ring },
            ]}
            pointerEvents="none"
          />

          <Text style={[styles.diveTitle, { color: colors.foreground }]}>
            start a dive
          </Text>
          <Text style={[styles.diveSubtitle, { color: colors.mutedForeground }]}>
            name this musical journey
          </Text>

          <TextInput
            value={diveName}
            onChangeText={setDiveName}
            placeholder="e.g. sunday melancholy"
            placeholderTextColor={colors.mutedForeground}
            returnKeyType="done"
            onSubmitEditing={handleStartDive}
            style={[
              styles.nameInput,
              {
                color: colors.foreground,
                backgroundColor: colors.card,
                borderColor: colors.border,
                borderRadius: colors.radius,
                fontFamily: 'Inter_400Regular',
              },
            ]}
          />

          <TouchableOpacity
            onPress={handleStartDive}
            disabled={createDive.isPending}
            activeOpacity={0.8}
            style={[
              styles.primaryBtn,
              {
                backgroundColor: colors.primary,
                borderRadius: colors.radius,
                opacity: createDive.isPending ? 0.7 : 1,
              },
            ]}
          >
            {createDive.isPending ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text
                style={[
                  styles.primaryBtnText,
                  { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' },
                ]}
              >
                dive
              </Text>
            )}
          </TouchableOpacity>

          {(appState?.diveCount ?? 0) > 0 && (
            <Text style={[styles.diveHint, { color: colors.mutedForeground }]}>
              starting a new dive archives the previous one
            </Text>
          )}
        </View>
      </View>
    );
  }

  // ── Get Directions ─────────────────────────────────────────────────────────
  if (phase.tag === 'get-directions') {
    const { diveId } = phase;
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <View
          style={[
            styles.centeredContent,
            { paddingTop: topPad + 24, paddingBottom: botPad + 24 },
          ]}
        >
          <Ionicons name="compass-outline" size={52} color={colors.primary} />
          <Text style={[styles.diveTitle, { color: colors.foreground }]}>
            {appState?.activeDiveName ?? 'dive'}
          </Text>
          <Text style={[styles.diveSubtitle, { color: colors.mutedForeground }]}>
            ready for the next direction?
          </Text>

          <TouchableOpacity
            onPress={() => handleGetDirections(diveId)}
            disabled={getDirections.isPending}
            activeOpacity={0.8}
            style={[
              styles.primaryBtn,
              {
                backgroundColor: colors.primary,
                borderRadius: colors.radius,
                opacity: getDirections.isPending ? 0.7 : 1,
              },
            ]}
          >
            {getDirections.isPending ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color={colors.primaryForeground} />
                <Text
                  style={[
                    styles.primaryBtnText,
                    { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' },
                  ]}
                >
                  charting course…
                </Text>
              </View>
            ) : (
              <Text
                style={[
                  styles.primaryBtnText,
                  { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' },
                ]}
              >
                get directions
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity onPress={handleNewDive} activeOpacity={0.7} style={styles.secondaryBtn}>
            <Text style={[styles.secondaryBtnText, { color: colors.mutedForeground }]}>
              new dive
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Directions ─────────────────────────────────────────────────────────────
  if (phase.tag === 'directions' || phase.tag === 'choosing-step') {
    const diveId = phase.diveId;
    const data = phase.data;
    const isChoosing = phase.tag === 'choosing-step';

    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScrollView
          contentContainerStyle={[
            styles.directionsContent,
            { paddingTop: topPad + 16, paddingBottom: botPad + 24 },
          ]}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.hypothesis, { color: colors.mutedForeground }]}>
            {data.hypothesis}
          </Text>

          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
            choose a direction
          </Text>

          {data.directions.map((dir) => (
            <DirectionCard
              key={dir.label}
              label={dir.label}
              rationale={dir.rationale}
              isWellTrodden={dir.isWellTrodden}
              disabled={isChoosing}
              onPress={() => handleChooseDirection(dir.label, diveId, data)}
            />
          ))}

          {/* Well-trodden option — only shown if not already in directions list */}
          {data.wellTroddenDirection &&
            !data.directions.some(
              (d) => d.label === data.wellTroddenDirection.label,
            ) && (
              <DirectionCard
                key={data.wellTroddenDirection.label}
                label={data.wellTroddenDirection.label}
                rationale={data.wellTroddenDirection.rationale}
                isWellTrodden
                disabled={isChoosing}
                onPress={() =>
                  handleChooseDirection(
                    data.wellTroddenDirection.label,
                    diveId,
                    data,
                  )
                }
              />
            )}

          {isChoosing && (
            <View style={styles.choosingRow}>
              <ActivityIndicator color={colors.primary} />
              <Text style={[styles.choosingText, { color: colors.mutedForeground }]}>
                setting course…
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    );
  }

  // ── Getting Recs ───────────────────────────────────────────────────────────
  if (phase.tag === 'get-recs') {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <View
          style={[
            styles.centeredContent,
            { paddingTop: topPad + 24, paddingBottom: botPad + 24 },
          ]}
        >
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.diveSubtitle, { color: colors.mutedForeground }]}>
            finding your next discoveries…
          </Text>
        </View>
      </View>
    );
  }

  // ── Recs ────────────────────────────────────────────────────────────────────
  if (phase.tag === 'recs') {
    const { recs, diveId } = phase;
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <View style={[styles.recsHeader, { paddingTop: topPad + 12 }]}>
          <Text style={[styles.recsTitle, { color: colors.foreground }]}>
            recommendations
          </Text>
          <Text style={[styles.recsSubtitle, { color: colors.mutedForeground }]}>
            {recs.length} track{recs.length !== 1 ? 's' : ''} surfaced
          </Text>
        </View>

        <FlatList
          data={recs}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={{ paddingBottom: botPad + 80 }}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <RecCard rec={item} onRate={handleRate} />
          )}
        />

        <View
          style={[
            styles.continueBar,
            {
              bottom: botPad + 16,
              paddingHorizontal: 24,
            },
          ]}
        >
          <TouchableOpacity
            onPress={() => handleContinue(diveId)}
            activeOpacity={0.8}
            style={[
              styles.continueBtn,
              { backgroundColor: colors.primary, borderRadius: colors.radius },
            ]}
          >
            <Text
              style={[
                styles.primaryBtnText,
                { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' },
              ]}
            >
              next direction
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleNewDive}
            activeOpacity={0.7}
            style={[
              styles.endBtn,
              {
                borderColor: colors.border,
                borderRadius: colors.radius,
              },
            ]}
          >
            <Text style={[styles.secondaryBtnText, { color: colors.mutedForeground }]}>
              new dive
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  centeredContent: {
    flex: 1,
    paddingHorizontal: 32,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 20,
  },
  glowOrb: {
    position: 'absolute',
    top: -60,
    width: 280,
    height: 280,
    borderRadius: 140,
    opacity: 0.08,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 80,
    elevation: 0,
  },
  diveTitle: {
    fontSize: 28,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.5,
    textAlign: 'center',
  },
  diveSubtitle: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  nameInput: {
    width: '100%',
    height: 52,
    paddingHorizontal: 16,
    fontSize: 16,
    borderWidth: 1,
  },
  primaryBtn: {
    width: '100%',
    height: 52,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryBtnText: { fontSize: 16 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  secondaryBtn: { paddingVertical: 8 },
  secondaryBtnText: { fontSize: 14 },
  diveHint: { fontSize: 12, textAlign: 'center', lineHeight: 18 },
  directionsContent: { paddingHorizontal: 20, gap: 12 },
  hypothesis: { fontSize: 14, lineHeight: 21, fontStyle: 'italic', marginBottom: 4 },
  sectionLabel: { fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', marginTop: 4 },
  choosingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingTop: 8 },
  choosingText: { fontSize: 14 },
  recsHeader: { paddingHorizontal: 20, paddingBottom: 8 },
  recsTitle: { fontSize: 22, fontFamily: 'Inter_700Bold' },
  recsSubtitle: { fontSize: 13, marginTop: 2 },
  continueBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    gap: 10,
  },
  continueBtn: { flex: 1, height: 48, justifyContent: 'center', alignItems: 'center' },
  endBtn: { height: 48, paddingHorizontal: 18, justifyContent: 'center', alignItems: 'center', borderWidth: 1 },
});
