import React, { useState, useEffect, useContext } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { ThemeProvider, ThemeContext } from './contexts/ThemeContext';
import HomeScreen from './screens/HomeScreen';
import ChannelListScreen from './screens/ChannelListScreen';
import PlayerScreen from './screens/PlayerScreen';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseM3U } from './utils/parser';
import { ActivityIndicator, View, StyleSheet } from 'react-native';

const Stack = createStackNavigator();
const STORAGE_KEY = '@streameo_last_url';

function AppNavigator({ initialRouteName, initialParams }) {
  return (
    <Stack.Navigator initialRouteName={initialRouteName} screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Home" component={HomeScreen} />
      <Stack.Screen name="ChannelList" component={ChannelListScreen} initialParams={initialParams} />
      <Stack.Screen name="Player" component={PlayerScreen} />
    </Stack.Navigator>
  );
}

function AppContent() {
  const [initialRoute, setInitialRoute] = useState(null);
  const [initialParams, setInitialParams] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const { theme } = useContext(ThemeContext);

  useEffect(() => {
    const bootstrapAsync = async () => {
      try {
        const lastUrl = await AsyncStorage.getItem(STORAGE_KEY);
        if (lastUrl) {
          const res = await fetch(lastUrl);
          const text = await res.text();
          const playlist = parseM3U(text);
          if (playlist.length > 0) {
            setInitialParams({ playlist });
            setInitialRoute('ChannelList');
          } else {
            setInitialRoute('Home');
          }
        } else {
          setInitialRoute('Home');
        }
      } catch (e) {
        console.error("Failed to auto-load playlist, navigating to Home.", e);
        setInitialRoute('Home');
      } finally {
        setIsLoading(false);
      }
    };

    bootstrapAsync();
  }, []);

  if (isLoading) {
    return (
      <View style={[styles.loaderContainer, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.text} />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <AppNavigator initialRouteName={initialRoute} initialParams={initialParams} />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  loaderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
