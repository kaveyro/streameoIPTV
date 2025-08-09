import React, { useState, useEffect, useContext } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, SafeAreaView, StatusBar, Switch } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseM3U } from '../utils/parser';
import { ThemeContext } from '../contexts/ThemeContext';

const STORAGE_KEY = '@streameo_last_url';
const REFRESH_KEY = '@streameo_auto_refresh';
const PLAYER_KEY = '@streameo_use_custom_player';

export default function HomeScreen({ navigation }) {
  const { theme, isDarkMode, toggleTheme } = useContext(ThemeContext);
  const [url, setUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [useCustomPlayer, setUseCustomPlayer] = useState(true);

  useEffect(() => {
    const loadSettings = async () => {
      const lastUrl = await AsyncStorage.getItem(STORAGE_KEY);
      if (lastUrl) {
        setUrl(lastUrl);
      }
      const refresh = await AsyncStorage.getItem(REFRESH_KEY);
      setAutoRefresh(refresh === 'true');
      
      const playerChoice = await AsyncStorage.getItem(PLAYER_KEY);
      // Default to custom player if no setting is saved
      setUseCustomPlayer(playerChoice !== 'false');
    };
    loadSettings();
  }, []);

  const handleLoad = async (loader) => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      const { playlist, sourceUrl } = await loader();
      if (playlist.length === 0) {
        Alert.alert('Empty Playlist', 'The loaded playlist is empty or could not be parsed.');
        return;
      }
      if (sourceUrl) {
        await AsyncStorage.setItem(STORAGE_KEY, sourceUrl);
      }
      navigation.replace('ChannelList', { playlist });
    } catch (err) {
      Alert.alert('Error', `Failed to load playlist: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const loadFromUrl = () => {
    if (!url) {
      Alert.alert('Invalid URL', 'Please enter a valid playlist URL.');
      return;
    }
    handleLoad(async () => {
      const res = await fetch(url);
      const text = await res.text();
      return { playlist: parseM3U(text), sourceUrl: url };
    });
  };

  const loadFromFile = () => handleLoad(async () => {
    const file = await DocumentPicker.getDocumentAsync({ type: '*/*' });
    if (file.type === 'success') {
      const text = await fetch(file.uri).then(r => r.text());
      return { playlist: parseM3U(text) };
    }
    return { playlist: [] };
  });

  const toggleAutoRefresh = async (value) => {
    setAutoRefresh(value);
    await AsyncStorage.setItem(REFRESH_KEY, JSON.stringify(value));
  };

  const togglePlayer = async (value) => {
    setUseCustomPlayer(value);
    await AsyncStorage.setItem(PLAYER_KEY, JSON.stringify(value));
  };

  const clearData = async () => {
    Alert.alert(
      "Clear All Data",
      "Are you sure you want to delete all app data, including your playlist URL and favorites?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear Data",
          style: "destructive",
          onPress: async () => {
            try {
              await AsyncStorage.clear();
              setUrl('');
              Alert.alert("Success", "All app data has been cleared.");
            } catch (e) {
              Alert.alert("Error", "Failed to clear data.");
            }
          },
        },
      ]
    );
  };

  const styles = getStyles(theme);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <View style={styles.container}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Text style={styles.backButtonText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Settings</Text>
        
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Playlist</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter M3U Playlist URL"
            placeholderTextColor={theme.placeholder}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            keyboardType="url"
          />
          <TouchableOpacity style={styles.button} onPress={loadFromUrl} disabled={isLoading}>
            <Text style={styles.buttonText}>Update from URL</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={loadFromFile} disabled={isLoading}>
            <Text style={styles.buttonText}>Load from File</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Appearance</Text>
          <View style={styles.settingRow}>
            <Text style={styles.settingText}>Dark Mode</Text>
            <Switch
              trackColor={{ false: "#767577", true: theme.primary }}
              thumbColor={isDarkMode ? "#f4f3f4" : "#f4f3f4"}
              onValueChange={toggleTheme}
              value={isDarkMode}
            />
          </View>
          <View style={styles.settingRow}>
            <Text style={styles.settingText}>Use Custom Video Player</Text>
            <Switch
              trackColor={{ false: "#767577", true: theme.primary }}
              thumbColor={useCustomPlayer ? "#f4f3f4" : "#f4f3f4"}
              onValueChange={togglePlayer}
              value={useCustomPlayer}
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>General</Text>
          <View style={styles.settingRow}>
            <Text style={styles.settingText}>Auto-refresh playlist on startup</Text>
            <Switch
              trackColor={{ false: "#767577", true: theme.primary }}
              thumbColor={autoRefresh ? "#f4f3f4" : "#f4f3f4"}
              onValueChange={toggleAutoRefresh}
              value={autoRefresh}
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Data Management</Text>
          <TouchableOpacity style={[styles.button, styles.dangerButton]} onPress={clearData} disabled={isLoading}>
            <Text style={styles.buttonText}>Clear All Data</Text>
          </TouchableOpacity>
        </View>

        {isLoading && <ActivityIndicator size="large" color={theme.text} style={styles.loader} />}
      </View>
    </SafeAreaView>
  );
}

const getStyles = (theme) => StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: theme.background },
  container: { flex: 1, padding: 20 },
  backButton: { position: 'absolute', top: 20, left: 20, zIndex: 1 },
  backButtonText: { color: theme.text, fontSize: 24, fontWeight: 'bold' },
  title: { fontSize: 32, fontWeight: 'bold', color: theme.text, textAlign: 'center', marginVertical: 20 },
  section: { marginBottom: 30 },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: theme.text, marginBottom: 15, borderBottomWidth: 1, borderBottomColor: theme.border, paddingBottom: 5 },
  input: { backgroundColor: theme.secondary, color: theme.text, padding: 15, marginBottom: 15, borderRadius: 8, fontSize: 16 },
  button: { backgroundColor: theme.primary, padding: 15, borderRadius: 8, marginBottom: 12, alignItems: 'center' },
  dangerButton: { backgroundColor: theme.danger },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  settingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  settingText: { color: theme.text, fontSize: 16 },
  loader: { marginTop: 20 },
});
