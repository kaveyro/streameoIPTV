import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, SafeAreaView, StatusBar } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseM3U } from '../utils/parser';

const STORAGE_KEY = '@streameo_last_url';

export default function HomeScreen({ navigation }) {
  const [url, setUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const loadLastUrl = async () => {
      const lastUrl = await AsyncStorage.getItem(STORAGE_KEY);
      if (lastUrl) {
        setUrl(lastUrl);
      }
    };
    loadLastUrl();
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
      navigation.navigate('ChannelList', { playlist });
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

  const loadSample = () => handleLoad(async () => {
    const sample = `#EXTM3U
#EXTINF:-1 tvg-id="sample1" tvg-logo="https://i.imgur.com/p2LBg1x.png" group-title="News",Sintel (HLS)
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
#EXTINF:-1 tvg-id="sample2" tvg-logo="https://i.imgur.com/p2LBg1x.png" group-title="Movies",Big Buck Bunny (MP4)
http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4`;
    return { playlist: parseM3U(sample) };
  });

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      <View style={styles.container}>
        <Text style={styles.title}>StreameoIPTV</Text>
        <Text style={styles.subtitle}>Your Modern IPTV Player</Text>
        <TextInput
          style={styles.input}
          placeholder="Enter M3U Playlist URL"
          placeholderTextColor="#888"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          keyboardType="url"
        />
        <TouchableOpacity style={styles.button} onPress={loadFromUrl} disabled={isLoading}>
          <Text style={styles.buttonText}>Load from URL</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.button} onPress={loadFromFile} disabled={isLoading}>
          <Text style={styles.buttonText}>Load from File</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.button} onPress={loadSample} disabled={isLoading}>
          <Text style={styles.buttonText}>Load Sample Playlist</Text>
        </TouchableOpacity>
        {isLoading && <ActivityIndicator size="large" color="#fff" style={styles.loader} />}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#121212' },
  container: { flex: 1, justifyContent: 'center', padding: 20 },
  title: { fontSize: 36, fontWeight: 'bold', color: '#fff', textAlign: 'center', marginBottom: 10 },
  subtitle: { fontSize: 16, color: '#aaa', textAlign: 'center', marginBottom: 40 },
  input: { backgroundColor: '#222', color: '#fff', padding: 15, marginBottom: 15, borderRadius: 8, fontSize: 16 },
  button: { backgroundColor: '#1e90ff', padding: 15, borderRadius: 8, marginBottom: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  loader: { marginTop: 20 },
});
