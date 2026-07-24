import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useUser } from '@/context/UserContext';
import { useCreateUser } from '@workspace/api-client-react';

export default function NameGateScreen() {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { login } = useUser();
  const createUser = useCreateUser();

  const handleDive = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length < 1) {
      setError('A name is required to dive.');
      return;
    }
    setError('');

    try {
      const user = await createUser.mutateAsync({ data: { name: trimmed } });
      await login(user.id, user.name);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      if (user.hasPortrait && user.seedCount >= 5) {
        router.replace('/(tabs)');
      } else {
        router.replace('/onboarding');
      }
    } catch {
      setError('Something went wrong. Please try again.');
    }
  };

  const canSubmit = name.trim().length > 0 && !createUser.isPending;

  return (
    <LinearGradient
      colors={[colors.background, '#040608']}
      style={StyleSheet.absoluteFill}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <View
          style={[
            styles.container,
            {
              paddingTop:
                Platform.OS === 'web' ? 67 : insets.top + 40,
              paddingBottom:
                Platform.OS === 'web' ? 34 : insets.bottom + 24,
            },
          ]}
        >
          {/* Glow orb */}
          <View
            style={[
              styles.glowOrb,
              { backgroundColor: colors.primary, shadowColor: colors.ring },
            ]}
          />

          {/* Heading */}
          <View style={styles.hero}>
            <Text style={[styles.wordmark, { color: colors.foreground }]}>
              trails
            </Text>
            <Text style={[styles.tagline, { color: colors.mutedForeground }]}>
              a musical submarine
            </Text>
          </View>

          {/* Input area */}
          <View style={styles.form}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>
              how do we call you?
            </Text>
            <TextInput
              value={name}
              onChangeText={(t) => {
                setName(t);
                if (error) setError('');
              }}
              placeholder="your name"
              placeholderTextColor={colors.mutedForeground}
              returnKeyType="done"
              onSubmitEditing={handleDive}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.input,
                {
                  color: colors.foreground,
                  backgroundColor: colors.card,
                  borderColor: name.trim() ? colors.primary : colors.border,
                  borderRadius: colors.radius,
                  fontFamily: 'Inter_400Regular',
                },
              ]}
            />
            {error ? (
              <Text style={[styles.error, { color: colors.destructive }]}>
                {error}
              </Text>
            ) : null}

            <TouchableOpacity
              onPress={handleDive}
              disabled={!canSubmit}
              activeOpacity={0.8}
              style={[
                styles.button,
                {
                  backgroundColor: canSubmit ? colors.primary : colors.muted,
                  borderRadius: colors.radius,
                },
              ]}
            >
              {createUser.isPending ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text
                  style={[
                    styles.buttonText,
                    {
                      color: canSubmit
                        ? colors.primaryForeground
                        : colors.mutedForeground,
                      fontFamily: 'Inter_600SemiBold',
                    },
                  ]}
                >
                  dive in
                </Text>
              )}
            </TouchableOpacity>
          </View>

          <Text style={[styles.footer, { color: colors.mutedForeground }]}>
            returning? use the same name to resume your dives.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: {
    flex: 1,
    paddingHorizontal: 32,
    justifyContent: 'center',
    gap: 40,
  },
  glowOrb: {
    position: 'absolute',
    top: -100,
    alignSelf: 'center',
    width: 300,
    height: 300,
    borderRadius: 150,
    opacity: 0.06,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 80,
    elevation: 0,
  },
  hero: { gap: 6 },
  wordmark: {
    fontSize: 48,
    letterSpacing: -2,
    fontFamily: 'Inter_700Bold',
  },
  tagline: {
    fontSize: 15,
    letterSpacing: 1,
  },
  form: { gap: 12 },
  label: {
    fontSize: 13,
    letterSpacing: 0.5,
  },
  input: {
    height: 52,
    paddingHorizontal: 16,
    fontSize: 16,
    borderWidth: 1,
  },
  error: { fontSize: 13, marginTop: 2 },
  button: {
    height: 52,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: { fontSize: 16, letterSpacing: 0.5 },
  footer: { fontSize: 12, textAlign: 'center', lineHeight: 18 },
});
