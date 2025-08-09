import React, { useState, useMemo, useEffect, useContext } from 'react';
import { View, Text, TextInput, SectionList, TouchableOpacity, StyleSheet, Image, SafeAreaView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeContext } from '../contexts/ThemeContext';

const PLAYER_KEY = '@streameo_use_custom_player';

export default function ChannelListScreen({ route, navigation }) {
  const { theme } = useContext(ThemeContext);
  const { playlist, favoritesOnly = false } = route.params;
  const [searchQuery, setSearchQuery] = useState('');
  const [favorites, setFavorites] = useState([]);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(favoritesOnly);
  const [useCustomPlayer, setUseCustomPlayer] = useState(true);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        // Load favorites
        const favs = await AsyncStorage.getItem('favorites');
        if (favs) {
          setFavorites(JSON.parse(favs));
        }
        // Load player preference
        const playerChoice = await AsyncStorage.getItem(PLAYER_KEY);
        setUseCustomPlayer(playerChoice !== 'false');
      } catch (e) {
        console.error('Failed to load settings.', e);
      }
    };
    loadSettings();
  }, []);

  const toggleFavorite = async (channel) => {
    let newFavorites;
    if (favorites.some(fav => fav.url === channel.url)) {
      newFavorites = favorites.filter(fav => fav.url !== channel.url);
    } else {
      newFavorites = [...favorites, channel];
    }
    setFavorites(newFavorites);
    try {
      await AsyncStorage.setItem('favorites', JSON.stringify(newFavorites));
    } catch (e) {
      console.error('Failed to save favorites.', e);
    }
  };

  const filteredPlaylist = useMemo(() => {
    let channels = showFavoritesOnly ? favorites : playlist;
    if (searchQuery) {
      channels = channels.filter(item =>
        item.title.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }
    return channels;
  }, [searchQuery, playlist, favorites, showFavoritesOnly]);

  const groupedData = useMemo(() => {
    const groups = filteredPlaylist.reduce((acc, channel) => {
      const groupName = channel.group || 'Uncategorized';
      if (!acc[groupName]) {
        acc[groupName] = [];
      }
      acc[groupName].push(channel);
      return acc;
    }, {});
    return Object.entries(groups).map(([group, channels]) => ({
      title: group,
      data: channels,
    }));
  }, [filteredPlaylist]);

  const styles = getStyles(theme);
  const renderChannelItem = ({ item }) => {
    const isFavorite = favorites.some(fav => fav.url === item.url);
    return (
      <View style={styles.itemContainer}>
        <TouchableOpacity style={styles.item} onPress={() => navigation.navigate('Player', { channel: item, useCustomPlayer })}>
          {item.logo ? (
            <Image source={{ uri: item.logo }} style={styles.logo} />
          ) : (
            <View style={styles.logoPlaceholder}>
              <Text style={styles.logoPlaceholderText}>{item.title.charAt(0)}</Text>
            </View>
          )}
          <Text style={styles.itemText} numberOfLines={1}>{item.title}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => toggleFavorite(item)} style={styles.favoriteButton}>
          <Text style={isFavorite ? styles.favoriteIconEnabled : styles.favoriteIconDisabled}>★</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
            <Text style={styles.backButtonText}>←</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Channels</Text>
          <TouchableOpacity onPress={() => setShowFavoritesOnly(!showFavoritesOnly)} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>{showFavoritesOnly ? 'All' : 'Favs'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => navigation.navigate('Home')} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>⚙️</Text>
          </TouchableOpacity>
        </View>
        <TextInput
          style={styles.searchBar}
          placeholder="Search channels..."
          placeholderTextColor={theme.placeholder}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        <SectionList
          sections={groupedData}
          keyExtractor={(item, index) => item.id ? `channel-${item.id}-${index}` : `channel-index-${index}`}
          renderItem={renderChannelItem}
          renderSectionHeader={({ section: { title } }) => (
            <Text style={styles.sectionHeader}>{title}</Text>
          )}
          ListEmptyComponent={<Text style={styles.emptyText}>No channels found.</Text>}
          stickySectionHeadersEnabled
        />
      </View>
    </SafeAreaView>
  );
}

const getStyles = (theme) => StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: theme.background },
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    backgroundColor: theme.header,
  },
  backButton: {
    padding: 5,
    marginRight: 15,
  },
  backButtonText: {
    color: theme.text,
    fontSize: 24,
    fontWeight: 'bold',
  },
  headerTitle: {
    color: theme.text,
    fontSize: 20,
    fontWeight: 'bold',
    flex: 1,
    textAlign: 'center',
  },
  headerButton: {
    padding: 5,
  },
  headerButtonText: {
    color: theme.text,
    fontSize: 16,
    fontWeight: 'bold',
  },
  searchBar: {
    backgroundColor: theme.secondary,
    color: theme.text,
    padding: 12,
    margin: 15,
    borderRadius: 8,
    fontSize: 16,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 15,
    flex: 1,
  },
  itemContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.secondary,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  favoriteButton: {
    padding: 15,
  },
  favoriteIconEnabled: {
    fontSize: 24,
    color: theme.favorite,
  },
  favoriteIconDisabled: {
    fontSize: 24,
    color: theme.favoriteDisabled,
  },
  logo: {
    width: 50,
    height: 50,
    marginRight: 15,
    borderRadius: 8,
    backgroundColor: theme.secondary,
  },
  logoPlaceholder: {
    width: 50,
    height: 50,
    marginRight: 15,
    borderRadius: 8,
    backgroundColor: theme.secondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoPlaceholderText: {
    color: theme.text,
    fontSize: 20,
    fontWeight: 'bold',
  },
  itemText: {
    color: theme.text,
    fontSize: 16,
    flex: 1,
  },
  sectionHeader: {
    fontSize: 18,
    fontWeight: 'bold',
    color: theme.text,
    backgroundColor: theme.background,
    paddingVertical: 8,
    paddingHorizontal: 15,
  },
  emptyText: {
    color: theme.subtleText,
    textAlign: 'center',
    marginTop: 50,
    fontSize: 16,
  },
});
