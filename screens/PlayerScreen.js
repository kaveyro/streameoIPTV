import React, { useState, useRef, useContext, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, StatusBar, ActivityIndicator, Animated, Easing, Image } from 'react-native';
import { Video, Audio } from 'expo-av';
import { ThemeContext } from '../contexts/ThemeContext';
import Slider from '@react-native-community/slider';
import * as ScreenOrientation from 'expo-screen-orientation';

// Helper to format time from seconds to HH:MM:SS
const formatTime = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h > 0 ? h : null, m, s]
    .filter(Boolean)
    .map(v => v < 10 ? `0${v}` : v)
    .join(':');
};

export default function PlayerScreen({ route, navigation }) {
  const { theme, isDarkMode } = useContext(ThemeContext);
  const { channel, useCustomPlayer } = route.params;
  
  const videoRef = useRef(null);
  const [status, setStatus] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  let controlTimeout = useRef(null);

  const styles = getStyles(theme);

  useEffect(() => {
    Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });

    // Lock to landscape if entering full screen, otherwise allow any orientation
    const setOrientation = async () => {
      if (isFullScreen) {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE_RIGHT);
      } else {
        await ScreenOrientation.unlockAsync();
      }
    };
    setOrientation();

    // Cleanup orientation lock on component unmount
    return () => {
      ScreenOrientation.unlockAsync();
    };
  }, [isFullScreen]);

  const hideControls = () => {
    Animated.timing(controlsOpacity, {
      toValue: 0,
      duration: 300,
      easing: Easing.ease,
      useNativeDriver: true,
    }).start(() => setShowControls(false));
  };

  const displayControls = () => {
    setShowControls(true);
    Animated.timing(controlsOpacity, {
      toValue: 1,
      duration: 300,
      easing: Easing.ease,
      useNativeDriver: true,
    }).start();

    if (controlTimeout.current) {
      clearTimeout(controlTimeout.current);
    }
    controlTimeout.current = setTimeout(hideControls, 5000);
  };

  const togglePlayPause = () => {
    if (status.isPlaying) {
      videoRef.current.pauseAsync();
    } else {
      videoRef.current.playAsync();
    }
    displayControls();
  };

  const onSliderValueChange = (value) => {
    videoRef.current.setPositionAsync(value * status.durationMillis);
    displayControls();
  };

  const toggleFullScreen = () => {
    setIsFullScreen(!isFullScreen);
  };

  if (!useCustomPlayer) {
    // Render the default native player
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
        <Video
          source={{ uri: channel.url }}
          style={styles.container}
          useNativeControls
          resizeMode={Video.RESIZE_MODE_CONTAIN}
          shouldPlay
          onError={(e) => console.error('Video Error:', e)}
        />
        {/* Add a simple back button for the native player view */}
        <TouchableOpacity style={styles.nativeBackButton} onPress={() => navigation.goBack()}>
          <Text style={styles.controlText}>←</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // Render the custom player
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar hidden={isFullScreen} />
      <TouchableOpacity activeOpacity={1} style={styles.container} onPress={displayControls}>
        <Video
          ref={videoRef}
          source={{ uri: channel.url }}
          style={StyleSheet.absoluteFill}
          useNativeControls={false}
          resizeMode={Video.RESIZE_MODE_CONTAIN}
          shouldPlay
          onPlaybackStatusUpdate={(s) => {
            setStatus(s);
            if (s.isLoaded && isLoading) setIsLoading(false);
          }}
          onError={(e) => console.error('Video Error:', e)}
        />

        {isLoading && (
          <View style={styles.loader}>
            <ActivityIndicator size="large" color="#fff" />
          </View>
        )}

        {showControls && (
          <Animated.View style={[styles.controlsOverlay, { opacity: controlsOpacity }]}>
            {/* Top Controls */}
            <View style={styles.topControls}>
              <TouchableOpacity style={styles.backButton} onPress={() => isFullScreen ? toggleFullScreen() : navigation.goBack()}>
                <Text style={styles.controlText}>←</Text>
              </TouchableOpacity>
              <View style={styles.channelInfo}>
                {channel.logo && <Image source={{ uri: channel.logo }} style={styles.channelLogo} />}
                <Text style={styles.channelTitle}>{channel.title}</Text>
              </View>
            </View>

            {/* Middle Controls (Play/Pause) */}
            <View style={styles.middleControls}>
              <TouchableOpacity onPress={togglePlayPause}>
                <Text style={styles.controlIcon}>{status.isPlaying ? '❚❚' : '▶'}</Text>
              </TouchableOpacity>
            </View>

            {/* Bottom Controls */}
            <View style={styles.bottomControls}>
              <Text style={styles.timeText}>{formatTime(status.positionMillis / 1000)}</Text>
              <Slider
                style={styles.slider}
                minimumValue={0}
                maximumValue={1}
                value={status.isLoaded ? status.positionMillis / status.durationMillis : 0}
                onValueChange={onSliderValueChange}
                minimumTrackTintColor="#fff"
                maximumTrackTintColor="rgba(255,255,255,0.5)"
                thumbTintColor="#fff"
                disabled={!status.isLoaded || !status.durationMillis}
              />
              <Text style={styles.timeText}>{formatTime(status.durationMillis / 1000)}</Text>
              <TouchableOpacity onPress={toggleFullScreen}>
                <Text style={styles.controlIcon}>⛶</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        )}
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const getStyles = (theme) => StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#000' },
  container: { flex: 1, backgroundColor: '#000', justifyContent: 'center' },
  nativeBackButton: { position: 'absolute', top: 40, left: 15, backgroundColor: 'rgba(0,0,0,0.6)', padding: 10, borderRadius: 50, zIndex: 10 },
  loader: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.7)' },
  controlsOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'space-between' },
  topControls: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 15 },
  backButton: { padding: 5 },
  controlText: { color: '#fff', fontSize: 24, fontWeight: 'bold' },
  channelInfo: { flexDirection: 'row', alignItems: 'center', flex: 1, marginLeft: 15 },
  channelLogo: { width: 30, height: 30, marginRight: 10, borderRadius: 4 },
  channelTitle: { color: '#fff', fontSize: 16, fontWeight: 'bold', flex: 1 },
  middleControls: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  controlIcon: { color: '#fff', fontSize: 40 },
  bottomControls: { flexDirection: 'row', alignItems: 'center', padding: 15 },
  timeText: { color: '#fff', marginHorizontal: 10 },
  slider: { flex: 1, marginHorizontal: 10 },
});
