import { useEffect, useRef } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useUser } from '@/context/UserContext';
import { useColors } from '@/hooks/useColors';

/**
 * Root entry point. Redirects to name-gate, onboarding, or the main tabs
 * based on authentication state. Renders the background colour only, so the
 * transition from the splash screen is seamless.
 */
export default function IndexScreen() {
  const { userId, appState, isLoading } = useUser();
  const router = useRouter();
  const didNavigate = useRef(false);
  const colors = useColors();

  useEffect(() => {
    if (isLoading || didNavigate.current) return;
    didNavigate.current = true;

    if (!userId) {
      router.replace('/name-gate');
    } else if (!appState?.onboarded) {
      router.replace('/onboarding');
    } else {
      router.replace('/(tabs)');
    }
  }, [isLoading, userId, appState?.onboarded, router]);

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.background,
          paddingTop: Platform.OS === 'web' ? 67 : 0,
        },
      ]}
    >
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});
