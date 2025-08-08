import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Image,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Video } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseM3U } from './utils/parser';

const STORAGE_KEY = '@streameo_last_url';

export default function App() {
  const [playlist, setPlaylist] = useState([]);
  const [url, setUrl] = useState('');
  const [current, setCurrent] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const videoRef = useRef(null);

  // Load the last used URL from storage on app start
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
    setIsLoading(true);
    try {
      const { playlist: newPlaylist, sourceUrl } = await loader();
      setPlaylist(newPlaylist);
      if (sourceUrl) {
        await AsyncStorage.setItem(STORAGE_KEY, sourceUrl);
      }
    } catch (err) {
      Alert.alert('Error', `Failed to load playlist: ${err.message}`);
      setPlaylist([]);
    } finally {
      setIsLoading(false);
    }
  };

  const loadFromUrl = () => handleLoad(async () => {
    const res = await fetch(url);
    const text = await res.text();
    return { playlist: parseM3U(text), sourceUrl: url };
  });

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
#EXTINF:-1 tvg-id="sample1" tvg-logo="https://i.imgur.com/p2LBg1x.png",Sintel (HLS)
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
#EXTINF:-1 tvg-id="sample2" tvg-logo="https://i.imgur.com/p2LBg1x.png",Big Buck Bunny (MP4)
http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4`;
    return { playlist: parseM3U(sample) };
  });

  const renderContent = () => {
    if (current) {
      return (
        <View style={styles.videoContainer}>
          <Video
            ref={videoRef}
            source={{ uri: current.url }}
            style={styles.video}
            useNativeControls
            resizeMode="contain"
            shouldPlay
            onFullscreenUpdate={({ fullscreenUpdate }) => {
              if (fullscreenUpdate === Video.FULLSCREEN_UPDATE_PLAYER_DID_DISMISS) {
                // This can be used to trigger actions when fullscreen is exited
              }
            }}
          />
          <TouchableOpacity style={styles.backButton} onPress={() => setCurrent(null)}>
            <Text style={styles.backButtonText}>← Back to Playlist</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <>
        <Text style={styles.title}>StreameoIPTV</Text>
        <TextInput
          style={styles.input}
          placeholder="Enter playlist URL"
          placeholderTextColor="#888"
          value={url}
          onChangeText={setUrl}
        />
        <View style={styles.buttonGroup}>
          <TouchableOpacity style={styles.button} onPress={loadFromUrl}>
            <Text style={styles.buttonText}>Load from URL</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={loadFromFile}>
            <Text style={styles.buttonText}>Load from File</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={loadSample}>
            <Text style={styles.buttonText}>Sample</Text>
          </TouchableOpacity>
        </View>

        {isLoading ? (
          <ActivityIndicator size="large" color="#fff" style={styles.loader} />
        ) : (
          <FlatList
            data={playlist}
            keyExtractor={(item, index) => item.id || index.toString()}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.item} onPress={() => setCurrent(item)}>
                {item.logo ? (
                  <Image source={{ uri: item.logo }} style={styles.logo} />
                ) : (
                  <View style={styles.logoPlaceholder} />
                )}
                <Text style={styles.itemText}>{item.title}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={<Text style={styles.emptyText}>No channels loaded. Use a button above.</Text>}
          />
        )}
      </>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      <View style={styles.container}>{renderContent()}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#000' },
  container: { flex: 1, padding: 15 },
  title: { fontSize: 28, fontWeight: 'bold', color: '#fff', marginBottom: 20, textAlign: 'center' },
  input: { backgroundColor: '#222', color: '#fff', padding: 12, marginBottom: 10, borderRadius: 5 },
  buttonGroup: { marginBottom: 15 },
  button: { backgroundColor: '#333', padding: 12, borderRadius: 5, marginBottom: 8 },
  buttonText: { color: '#fff', textAlign: 'center', fontWeight: 'bold' },
  item: { flexDirection: 'row', alignItems: 'center', padding: 12, backgroundColor: '#111', marginBottom: 6, borderRadius: 5 },
  logo: { width: 40, height: 40, marginRight: 12, borderRadius: 4 },
  logoPlaceholder: { width: 40, height: 40, marginRight: 12, backgroundColor: '#333', borderRadius: 4 },
  itemText: { color: '#fff', fontSize: 16 },
  videoContainer: { flex: 1, backgroundColor: '#000' },
  video: { flex: 1 },
  backButton: { position: 'absolute', top: 20, left: 15, backgroundColor: 'rgba(0,0,0,0.6)', padding: 10, borderRadius: 5 },
  backButtonText: { color: '#fff', fontSize: 16 },
  loader: { marginTop: 50 },
  emptyText: { color: '#777', textAlign: 'center', marginTop: 40 },
});
