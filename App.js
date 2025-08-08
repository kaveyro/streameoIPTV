// Full App.js code with HLS/ExoPlayer support
import React, { useState, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, TextInput, StyleSheet, Image } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Video } from 'expo-av';
import { parseM3U } from './utils/parser';

export default function App() {
  const [playlist, setPlaylist] = useState([]);
  const [url, setUrl] = useState('');
  const [current, setCurrent] = useState(null);

  const loadSample = async () => {
    const sample = `#EXTM3U
#EXTINF:-1 tvg-id="sample1" tvg-logo="",Sample Channel 1
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
#EXTINF:-1,Sample Channel 2
http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4`;
    setPlaylist(parseM3U(sample));
  };

  const loadFromUrl = async () => {
    try {
      const res = await fetch(url);
      const text = await res.text();
      setPlaylist(parseM3U(text));
    } catch (err) {
      console.error('Failed to load playlist', err);
    }
  };

  const loadFromFile = async () => {
    try {
      const file = await DocumentPicker.getDocumentAsync({ type: '*/*' });
      if (file.type === 'success') {
        const text = await fetch(file.uri).then(r => r.text());
        setPlaylist(parseM3U(text));
      }
    } catch (err) {
      console.error('Failed to load file', err);
    }
  };

  return (
    <View style={styles.container}>
      {!current ? (
        <>
          <Text style={styles.title}>StreameoIPTV</Text>
          <TextInput style={styles.input} placeholder="Enter playlist URL" value={url} onChangeText={setUrl} />
          <TouchableOpacity style={styles.button} onPress={loadFromUrl}>
            <Text style={styles.buttonText}>Load from URL</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={loadFromFile}>
            <Text style={styles.buttonText}>Load from File</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={loadSample}>
            <Text style={styles.buttonText}>Sample</Text>
          </TouchableOpacity>
          <FlatList
            data={playlist}
            keyExtractor={(item, index) => index.toString()}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.item} onPress={() => setCurrent(item)}>
                {item.logo ? <Image source={{ uri: item.logo }} style={styles.logo} /> : <View style={styles.logoPlaceholder} />}
                <Text style={styles.itemText}>{item.title}</Text>
              </TouchableOpacity>
            )}
          />
        </>
      ) : (
        <Video
          source={{ uri: current.url }}
          style={styles.video}
          useNativeControls
          resizeMode="contain"
          shouldPlay
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', padding: 10 },
  title: { fontSize: 24, color: '#fff', marginBottom: 10 },
  input: { backgroundColor: '#222', color: '#fff', padding: 8, marginBottom: 8 },
  button: { backgroundColor: '#444', padding: 10, marginBottom: 8 },
  buttonText: { color: '#fff', textAlign: 'center' },
  item: { flexDirection: 'row', alignItems: 'center', padding: 8, backgroundColor: '#111', marginBottom: 4 },
  logo: { width: 50, height: 50, marginRight: 10 },
  logoPlaceholder: { width: 50, height: 50, marginRight: 10, backgroundColor: '#333' },
  itemText: { color: '#fff' },
  video: { flex: 1 }
});
