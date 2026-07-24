import { useState, useCallback } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  getGetPortraitQueryOptions,
  getGetMetricsQueryOptions,
  useGeneratePortrait,
  useUpdatePortrait,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useUser } from '@/context/UserContext';

export default function PortraitScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { userId, appState, refreshState } = useUser();
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');

  const portraitQuery = useQuery({
    ...getGetPortraitQueryOptions({ userId: userId ?? 0 }),
    enabled: !!userId,
    retry: false,
  });

  const metricsQuery = useQuery({
    ...getGetMetricsQueryOptions({ userId: userId ?? 0 }),
    enabled: !!userId,
    retry: false,
  });

  // Refetch metrics (and portrait) when the tab comes into focus
  useFocusEffect(
    useCallback(() => {
      if (!userId) return;
      metricsQuery.refetch();
      portraitQuery.refetch();
    }, [userId]) // eslint-disable-line react-hooks/exhaustive-deps
  );

  const generatePortrait = useGeneratePortrait();
  const updatePortrait = useUpdatePortrait();

  const portrait = portraitQuery.data;
  const metrics = metricsQuery.data;

  const handleEdit = () => {
    if (!portrait) return;
    setEditText(portrait.text);
    setEditing(true);
  };

  const handleSave = async () => {
    if (!userId || !editText.trim()) return;
    await updatePortrait.mutateAsync({ data: { userId, text: editText.trim() } });
    portraitQuery.refetch();
    setEditing(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleRegenerate = async () => {
    if (!userId) return;
    await generatePortrait.mutateAsync({ data: { userId } });
    portraitQuery.refetch();
    await refreshState();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const topPad = Platform.OS === 'web' ? 67 : insets.top + 12;
  const botPad = Platform.OS === 'web' ? 34 : insets.bottom + 24;

  // Arm comparison helpers
  const llmArm = metrics?.byArm.find((a) => a.arm === 'llm');
  const wellTroddenArm = metrics?.byArm.find((a) => a.arm === 'well_trodden');
  const maxArmScore = Math.max(
    llmArm?.avgScore ?? 0,
    wellTroddenArm?.avgScore ?? 0,
    0.01 // avoid division by zero
  );

  const fmt = (n: number | null | undefined, decimals = 0) =>
    n == null ? '—' : n.toFixed(decimals);

  const pct = (n: number | null | undefined) =>
    n == null ? '—' : `${Math.round(n * 100)}%`;

  return (
    <LinearGradient
      colors={[colors.background, '#020508']}
      style={[styles.screen]}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: topPad, paddingBottom: botPad },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.headerRow}>
          <View>
            <Text style={[styles.title, { color: colors.foreground }]}>
              your portrait
            </Text>
            {appState?.portraitVersion != null && (
              <Text style={[styles.version, { color: colors.mutedForeground }]}>
                v{appState.portraitVersion}
              </Text>
            )}
          </View>
          {portrait && !editing && (
            <TouchableOpacity onPress={handleEdit} activeOpacity={0.7}>
              <Ionicons name="pencil-outline" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          )}
        </View>

        {/* Portrait content */}
        {portraitQuery.isPending ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : portrait ? (
          <>
            {editing ? (
              <View style={styles.editArea}>
                <TextInput
                  value={editText}
                  onChangeText={setEditText}
                  multiline
                  style={[
                    styles.editInput,
                    {
                      color: colors.foreground,
                      backgroundColor: colors.card,
                      borderColor: colors.primary,
                      borderRadius: colors.radius,
                      fontFamily: 'Inter_400Regular',
                    },
                  ]}
                  placeholderTextColor={colors.mutedForeground}
                />
                <View style={styles.editBtns}>
                  <TouchableOpacity
                    onPress={() => setEditing(false)}
                    activeOpacity={0.7}
                    style={[
                      styles.editBtn,
                      {
                        borderColor: colors.border,
                        borderRadius: colors.radius,
                      },
                    ]}
                  >
                    <Text style={{ color: colors.mutedForeground, fontSize: 15 }}>
                      cancel
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleSave}
                    disabled={updatePortrait.isPending}
                    activeOpacity={0.8}
                    style={[
                      styles.editBtn,
                      {
                        backgroundColor: colors.primary,
                        borderRadius: colors.radius,
                        flex: 1,
                      },
                    ]}
                  >
                    {updatePortrait.isPending ? (
                      <ActivityIndicator color={colors.primaryForeground} />
                    ) : (
                      <Text
                        style={{
                          color: colors.primaryForeground,
                          fontSize: 15,
                          fontFamily: 'Inter_600SemiBold',
                        }}
                      >
                        save
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
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
                  {portrait.text}
                </Text>
                <Text style={[styles.portraitMeta, { color: colors.mutedForeground }]}>
                  {new Date(portrait.generatedAt).toLocaleDateString()} ·{' '}
                  {portrait.source === 'user_edit' ? 'edited' : 'ai generated'}
                </Text>
              </View>
            )}

            {!editing && (
              <TouchableOpacity
                onPress={handleRegenerate}
                disabled={generatePortrait.isPending}
                activeOpacity={0.7}
                style={styles.regenBtn}
              >
                {generatePortrait.isPending ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <>
                    <Ionicons name="refresh-outline" size={16} color={colors.mutedForeground} />
                    <Text style={[styles.regenText, { color: colors.mutedForeground }]}>
                      regenerate portrait
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </>
        ) : (
          /* No portrait yet */
          <View style={styles.emptyState}>
            <Ionicons name="person-circle-outline" size={56} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
              no portrait yet
            </Text>
            <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
              complete onboarding to generate your musical portrait.
            </Text>
          </View>
        )}

        {/* Dive + Seed Stats */}
        {appState && (
          <View
            style={[
              styles.statsRow,
              { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
            ]}
          >
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: colors.primary }]}>
                {appState.seedCount}
              </Text>
              <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
                seeds
              </Text>
            </View>
            <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: colors.primary }]}>
                {appState.diveCount}
              </Text>
              <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
                dives
              </Text>
            </View>
          </View>
        )}

        {/* Listening Insights */}
        {userId && (
          <View
            style={[
              styles.insightsCard,
              { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
            ]}
          >
            <Text style={[styles.insightsTitle, { color: colors.foreground }]}>
              listening insights
            </Text>

            {metricsQuery.isPending ? (
              <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 12 }} />
            ) : metrics ? (
              <>
                {/* Top-line numbers */}
                <View style={styles.metricsRow}>
                  <View style={styles.metricItem}>
                    <Text style={[styles.metricValue, { color: colors.primary }]}>
                      {metrics.totalRatedRecs}
                    </Text>
                    <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>
                      rated tracks
                    </Text>
                  </View>
                  <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
                  <View style={styles.metricItem}>
                    <Text style={[styles.metricValue, { color: colors.primary }]}>
                      {pct(metrics.overallDiscoveryRate)}
                    </Text>
                    <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>
                      discovery rate
                    </Text>
                  </View>
                </View>

                {/* Arm comparison bars */}
                {(llmArm || wellTroddenArm) && (
                  <View style={styles.armsSection}>
                    <Text style={[styles.armsTitle, { color: colors.mutedForeground }]}>
                      avg score by path
                    </Text>

                    {llmArm && (
                      <View style={styles.armRow}>
                        <Text style={[styles.armLabel, { color: colors.mutedForeground }]}>
                          llm
                        </Text>
                        <View style={[styles.barTrack, { backgroundColor: colors.border }]}>
                          <View
                            style={[
                              styles.barFill,
                              {
                                backgroundColor: colors.primary,
                                width: `${((llmArm.avgScore ?? 0) / maxArmScore) * 100}%`,
                                borderRadius: colors.radius,
                              },
                            ]}
                          />
                        </View>
                        <Text style={[styles.armScore, { color: colors.foreground }]}>
                          {fmt(llmArm.avgScore, 1)}
                        </Text>
                      </View>
                    )}

                    {wellTroddenArm && (
                      <View style={styles.armRow}>
                        <Text style={[styles.armLabel, { color: colors.mutedForeground }]}>
                          popular
                        </Text>
                        <View style={[styles.barTrack, { backgroundColor: colors.border }]}>
                          <View
                            style={[
                              styles.barFill,
                              {
                                backgroundColor: colors.accent,
                                width: `${((wellTroddenArm.avgScore ?? 0) / maxArmScore) * 100}%`,
                                borderRadius: colors.radius,
                              },
                            ]}
                          />
                        </View>
                        <Text style={[styles.armScore, { color: colors.foreground }]}>
                          {fmt(wellTroddenArm.avgScore, 1)}
                        </Text>
                      </View>
                    )}

                    {/* Discovery rates per arm */}
                    {(llmArm?.discoveryRate != null || wellTroddenArm?.discoveryRate != null) && (
                      <View style={[styles.armDiscoveryRow]}>
                        {llmArm?.discoveryRate != null && (
                          <Text style={[styles.armDiscovery, { color: colors.mutedForeground }]}>
                            llm {pct(llmArm.discoveryRate)} new
                          </Text>
                        )}
                        {wellTroddenArm?.discoveryRate != null && (
                          <Text style={[styles.armDiscovery, { color: colors.mutedForeground }]}>
                            popular {pct(wellTroddenArm.discoveryRate)} new
                          </Text>
                        )}
                      </View>
                    )}
                  </View>
                )}

                {metrics.totalRatedRecs === 0 && (
                  <Text style={[styles.noData, { color: colors.mutedForeground }]}>
                    rate tracks during a dive to see your taste evolve here.
                  </Text>
                )}
              </>
            ) : (
              <Text style={[styles.noData, { color: colors.mutedForeground }]}>
                could not load insights.
              </Text>
            )}
          </View>
        )}
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: 24, gap: 20 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  title: { fontSize: 26, fontFamily: 'Inter_700Bold', letterSpacing: -0.5 },
  version: { fontSize: 12, marginTop: 2 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 60 },
  portraitCard: { padding: 20, borderWidth: 1, gap: 12 },
  portraitText: { fontSize: 15, lineHeight: 26 },
  portraitMeta: { fontSize: 12 },
  editArea: { gap: 12 },
  editInput: {
    borderWidth: 1,
    padding: 14,
    fontSize: 15,
    lineHeight: 24,
    minHeight: 180,
    textAlignVertical: 'top',
  },
  editBtns: { flexDirection: 'row', gap: 10 },
  editBtn: {
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    borderWidth: 1,
  },
  regenBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center' },
  regenText: { fontSize: 13 },
  emptyState: { alignItems: 'center', gap: 12, paddingVertical: 40 },
  emptyTitle: { fontSize: 20, fontFamily: 'Inter_600SemiBold' },
  emptySubtitle: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  statsRow: { flexDirection: 'row', borderWidth: 1, padding: 20 },
  statItem: { flex: 1, alignItems: 'center', gap: 4 },
  statDivider: { width: 1 },
  statValue: { fontSize: 28, fontFamily: 'Inter_700Bold' },
  statLabel: { fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  // Insights card
  insightsCard: { borderWidth: 1, padding: 20, gap: 16 },
  insightsTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', textTransform: 'uppercase', letterSpacing: 0.8 },
  metricsRow: { flexDirection: 'row' },
  metricItem: { flex: 1, alignItems: 'center', gap: 4 },
  metricValue: { fontSize: 26, fontFamily: 'Inter_700Bold' },
  metricLabel: { fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  // Arm bars
  armsSection: { gap: 10 },
  armsTitle: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8 },
  armRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  armLabel: { fontSize: 12, width: 52 },
  barTrack: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: '100%' },
  armScore: { fontSize: 12, fontFamily: 'Inter_600SemiBold', width: 28, textAlign: 'right' },
  armDiscoveryRow: { flexDirection: 'row', gap: 16, marginTop: 2 },
  armDiscovery: { fontSize: 11 },
  noData: { fontSize: 13, lineHeight: 20, marginTop: 4 },
});
